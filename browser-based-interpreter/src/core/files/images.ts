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

export function isSupportedImageFile(file: File): boolean {
  return IMAGE_MEDIA_TYPES.includes(file.type);
}

interface ImagePickOutcome {
  attached: ImageAttachment[];
  skipped: { name: string; reason: string }[];
}

export async function pickImages(files: File[], alreadyStaged: number): Promise<ImagePickOutcome> {
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
    slotsLeft -= 1;
    attached.push({
      name: file.name,
      mediaType: file.type,
      data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
    });
  }

  return { attached, skipped };
}
