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


import { bytesToBase64 } from "../base64";
import { type ImageAttachment } from "../runtime/protocol";

const MB = 1024 * 1024;

export const MAX_IMAGE_BYTES = 8 * MB;
export const MAX_IMAGES_PER_MESSAGE = 4;
const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const IMAGE_ACCEPT = IMAGE_MEDIA_TYPES.join(",");
const KEEPS_ITS_TYPE = ["image/png", "image/jpeg", "image/webp"];
const REDRAW_QUALITY = 0.92;

export function isSupportedImageFile(file: File): boolean {
  return IMAGE_MEDIA_TYPES.includes(file.type);
}

export type RedrawImage = (file: File) => Promise<Blob>;

// Draws the picture onto an empty canvas and reads the canvas back, so only the pixels travel.
// Everything else the file carries - camera, date, location - stays on the device.
async function redrawOnCanvas(file: File): Promise<Blob> {
  const picture = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = picture.width;
    canvas.height = picture.height;
    const surface = canvas.getContext("2d");
    if (surface === null) throw new Error("The browser gave no drawing surface.");
    surface.drawImage(picture, 0, 0);
    const type = KEEPS_ITS_TYPE.includes(file.type) ? file.type : "image/png";
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob === null ? reject(new Error("The browser could not redraw it.")) : resolve(blob)), type, REDRAW_QUALITY);
    });
  } finally {
    picture.close();
  }
}

interface ImagePickOutcome {
  attached: ImageAttachment[];
  skipped: { name: string; reason: string }[];
}

export async function pickImages(files: File[], alreadyStaged: number, redraw: RedrawImage = redrawOnCanvas): Promise<ImagePickOutcome> {
  const attached: ImageAttachment[] = [];
  const skipped: { name: string; reason: string }[] = [];
  let slotsLeft = Math.max(0, MAX_IMAGES_PER_MESSAGE - alreadyStaged);

  for (const file of files) {
    if (!isSupportedImageFile(file)) {
      skipped.push({ name: file.name, reason: "is not a supported image type (PNG, JPEG, WEBP, or GIF)" });
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      skipped.push({ name: file.name, reason: `is larger than ${MAX_IMAGE_BYTES / MB} MB` });
      continue;
    }
    if (slotsLeft <= 0) {
      skipped.push({ name: file.name, reason: `would exceed the ${MAX_IMAGES_PER_MESSAGE}-image limit per message` });
      continue;
    }
    let redrawn: Blob;
    try {
      redrawn = await redraw(file);
    } catch {
      skipped.push({ name: file.name, reason: "could not be read as an image" });
      continue;
    }
    if (redrawn.size > MAX_IMAGE_BYTES) {
      skipped.push({ name: file.name, reason: `is larger than ${MAX_IMAGE_BYTES / MB} MB once it is redrawn` });
      continue;
    }
    slotsLeft -= 1;
    attached.push({
      name: file.name,
      mediaType: redrawn.type === "" ? file.type : redrawn.type,
      data: bytesToBase64(new Uint8Array(await redrawn.arrayBuffer())),
    });
  }

  return { attached, skipped };
}
