// Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
//
// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.


import { describe, it, expect } from "vitest";
import { isSupportedImageFile, MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE, pickImages, type RedrawImage } from "./images";

function imageFile(name: string, bytes: Uint8Array<ArrayBuffer>, type = "image/png"): File {
  return new File([bytes], name, { type });
}

// Stands in for the canvas: hands back different bytes, so a test can tell the two apart.
const REDRAWN_BYTES = new Uint8Array([1, 2, 3, 4]);
const redraw: RedrawImage = (file) =>
  Promise.resolve(new Blob([REDRAWN_BYTES], { type: file.type === "image/gif" ? "image/png" : file.type }));

describe("isSupportedImageFile", () => {
  it("accepts PNG, JPEG, WEBP, and GIF", () => {
    expect(isSupportedImageFile(imageFile("a.png", new Uint8Array(1), "image/png"))).toBe(true);
    expect(isSupportedImageFile(imageFile("a.jpg", new Uint8Array(1), "image/jpeg"))).toBe(true);
    expect(isSupportedImageFile(imageFile("a.webp", new Uint8Array(1), "image/webp"))).toBe(true);
    expect(isSupportedImageFile(imageFile("a.gif", new Uint8Array(1), "image/gif"))).toBe(true);
  });

  it("rejects a non-image type", () => {
    expect(isSupportedImageFile(imageFile("a.txt", new Uint8Array(1), "text/plain"))).toBe(false);
  });

  it("rejects an unsupported image type (e.g. SVG - not accepted by vision APIs)", () => {
    expect(isSupportedImageFile(imageFile("a.svg", new Uint8Array(1), "image/svg+xml"))).toBe(false);
  });
});

describe("pickImages", () => {
  it("sends the redrawn picture, never the bytes of the file the user picked", async () => {
    const original = new Uint8Array([137, 80, 78, 71]);
    const result = await pickImages([imageFile("shot.png", original)], 0, redraw);
    expect(result.attached).toEqual([
      { name: "shot.png", mediaType: "image/png", data: btoa("\x01\x02\x03\x04") },
    ]);
    expect(result.attached[0]?.data).not.toBe(btoa("\x89PNG"));
    expect(result.skipped).toEqual([]);
  });

  it("labels the picture with the type it was redrawn as, so a GIF goes as a PNG", async () => {
    const result = await pickImages([imageFile("loop.gif", new Uint8Array(1), "image/gif")], 0, redraw);
    expect(result.attached[0]?.mediaType).toBe("image/png");
  });

  it("skips a picture the browser cannot redraw, and keeps its place for the next one", async () => {
    const failing: RedrawImage = () => Promise.reject(new Error("broken"));
    const result = await pickImages([imageFile("a.png", new Uint8Array(1)), imageFile("b.png", new Uint8Array(1))], 0, failing);
    expect(result.attached).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      "could not be read as an image",
      "could not be read as an image",
    ]);
  });

  it("skips a picture that is over the cap once it is redrawn", async () => {
    const fat: RedrawImage = (file) => Promise.resolve(new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)], { type: file.type }));
    const result = await pickImages([imageFile("a.png", new Uint8Array(1))], 0, fat);
    expect(result.attached).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("once it is redrawn");
  });

  it("does not use up a slot for a picture that could not be redrawn", async () => {
    let calls = 0;
    const secondWorks: RedrawImage = (file) => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("broken")) : Promise.resolve(new Blob([REDRAWN_BYTES], { type: file.type }));
    };
    const files = [imageFile("bad.png", new Uint8Array(1)), imageFile("good.png", new Uint8Array(1))];
    const result = await pickImages(files, MAX_IMAGES_PER_MESSAGE - 1, secondWorks);
    expect(result.attached.map((i) => i.name)).toEqual(["good.png"]);
  });

  it("skips an unsupported file type with a clear reason", async () => {
    const result = await pickImages([imageFile("notes.txt", new Uint8Array(1), "text/plain")], 0, redraw);
    expect(result.attached).toEqual([]);
    expect(result.skipped).toEqual([
      { name: "notes.txt", reason: expect.stringContaining("not a supported image type") },
    ]);
  });

  it("skips a file over the size cap", async () => {
    const big = imageFile("huge.png", new Uint8Array(MAX_IMAGE_BYTES + 1));
    const result = await pickImages([big], 0, redraw);
    expect(result.attached).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("larger than 8 MB");
  });

  it("caps the total at MAX_IMAGES_PER_MESSAGE, counting what's already staged", async () => {
    const files = Array.from({ length: MAX_IMAGES_PER_MESSAGE }, (_, i) => imageFile(`${i}.png`, new Uint8Array(1)));
    const result = await pickImages(files, MAX_IMAGES_PER_MESSAGE - 1, redraw);
    expect(result.attached).toHaveLength(1);
    expect(result.skipped).toHaveLength(MAX_IMAGES_PER_MESSAGE - 1);
    expect(result.skipped.every((s) => s.reason.includes("limit"))).toBe(true);
  });

  it("partitions a mixed batch into attached and skipped without one bad file blocking the rest", async () => {
    const result = await pickImages(
      [imageFile("ok.png", new Uint8Array(1)), imageFile("bad.txt", new Uint8Array(1), "text/plain")],
      0,
      redraw,
    );
    expect(result.attached.map((i) => i.name)).toEqual(["ok.png"]);
    expect(result.skipped.map((s) => s.name)).toEqual(["bad.txt"]);
  });
});
