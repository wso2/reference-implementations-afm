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

import { type FileInfo } from "@afm/adapter-tool";
import { describeError } from "@afm/engine";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { type ImageAttachment } from "../runtime/protocol";
import { bytesToBase64 } from "../links/load-paths";
import { fileExtension } from "./file-labels";
import { ensurePdfWorker } from "./pdf-worker";

export const MAX_FILES = 100;

export interface CollectedFile {
  file: File;
  path: string;
}

export interface CollectResult {
  files: CollectedFile[];
  truncated: boolean;
}

function relativePathOf(file: File): string {
  return file.webkitRelativePath || file.name;
}

export function collectFromFileList(list: FileList): CollectResult {
  const files: CollectedFile[] = [];
  let truncated = false;
  for (const file of Array.from(list)) {
    if (files.length >= MAX_FILES) {
      truncated = true;
      break;
    }
    files.push({ file, path: relativePathOf(file) });
  }
  return { files, truncated };
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const readBatch = (): void => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

function entryToFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

export async function collectFromDataTransfer(items: DataTransferItemList): Promise<CollectResult> {
  const files: CollectedFile[] = [];
  let truncated = false;

  async function walk(entry: FileSystemEntry, prefix: string): Promise<void> {
    if (files.length >= MAX_FILES) {
      truncated = true;
      return;
    }
    if (entry.isFile) {
      const file = await entryToFile(entry as FileSystemFileEntry);
      files.push({ file, path: `${prefix}${entry.name}` });
      return;
    }
    if (entry.isDirectory) {
      const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
      for (const child of children) {
        if (files.length >= MAX_FILES) {
          truncated = true;
          break;
        }
        await walk(child, `${prefix}${entry.name}/`);
      }
    }
  }

  const roots: FileSystemEntry[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry();
    if (entry !== null) roots.push(entry);
  }

  for (const entry of roots) {
    if (files.length >= MAX_FILES) {
      truncated = true;
      break;
    }
    await walk(entry, "");
  }

  return { files, truncated };
}

export function splitDropped(collected: CollectedFile[]): { images: File[]; others: CollectedFile[] } {
  const isImage = ({ file, path }: CollectedFile) => !path.includes("/") && isSupportedImageFile(file);
  return {
    images: collected.filter(isImage).map(({ file }) => file),
    others: collected.filter((item) => !isImage(item)),
  };
}

export function supportsDirectoryDrop(items: DataTransferItemList): boolean {
  return items.length > 0 && typeof items[0]?.webkitGetAsEntry === "function";
}

const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_PDF_PAGES = 500;
export const MAX_PDF_MS = 30_000;
const SUPPORTED_EXTENSIONS = new Set(["pdf", "md", "markdown", "txt"]);

type ExtractResult = { ok: true; file: FileInfo } | { ok: false; name: string; reason: string };

async function extractPdfText(file: File): Promise<{ text: string; pages: number; note?: string }> {
  await ensurePdfWorker();
  const task = pdfjsLib.getDocument({ data: await file.arrayBuffer() });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void task.destroy();
  }, MAX_PDF_MS);
  const pageTexts: string[] = [];
  let pages = 0;
  try {
    const doc = await task.promise;
    pages = doc.numPages;
    for (let pageNumber = 1; pageNumber <= Math.min(pages, MAX_PDF_PAGES); pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
      pageTexts.push(`--- Page ${pageNumber} ---\n${text}`);
    }
  } catch (error) {
    if (!timedOut) throw error;
  } finally {
    clearTimeout(timer);
    await task.destroy();
  }
  if (timedOut && pageTexts.length === 0) throw new Error(`took longer than ${MAX_PDF_MS / 1000} seconds to read`);
  const text = pageTexts.join("\n\n");
  return pageTexts.length < pages
    ? { text, pages, note: `stopped after page ${pageTexts.length} of ${pages}` }
    : { text, pages };
}

export async function extractFile(file: File, path: string = file.name): Promise<ExtractResult> {
  const cleanPath = path.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, " ");
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, name: file.name, reason: `is larger than ${MAX_FILE_BYTES / (1024 * 1024)} MB` };
  }

  const ext = fileExtension(file.name);
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return { ok: false, name: file.name, reason: "is not a supported file type (PDF, Markdown, or plain text only)" };
  }

  try {
    if (ext === "pdf") {
      const { text, pages, note } = await extractPdfText(file);
      return {
        ok: true,
        file: { name: file.name, path: cleanPath, text, pages, ...(note === undefined ? {} : { note }) },
      };
    }
    const text = await file.text();
    return { ok: true, file: { name: file.name, path: cleanPath, text } };
  } catch (error) {
    return { ok: false, name: file.name, reason: `couldn't be read: ${describeError(error)}` };
  }
}

interface BatchExtractResult {
  attached: FileInfo[];
  skipped: { name: string; reason: string }[];
  sizes: Map<string, number>;
}

export async function extractFiles(
  collected: CollectedFile[],
  remainingBytes = MAX_TOTAL_BYTES,
): Promise<BatchExtractResult> {
  const attached: FileInfo[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const sizes = new Map<string, number>();
  for (const { file, path } of collected) {
    if (file.size > remainingBytes) {
      skipped.push({
        name: file.name,
        reason: `would go over the ${MAX_TOTAL_BYTES / (1024 * 1024)} MB limit for all files`,
      });
      continue;
    }
    const result = await extractFile(file, path);
    if (result.ok) {
      attached.push(result.file);
      sizes.set(result.file.path, file.size);
      remainingBytes -= file.size;
    } else {
      skipped.push({ name: result.name, reason: result.reason });
    }
  }
  return { attached, skipped, sizes };
}

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
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
      skipped.push({ name: file.name, reason: `is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB` });
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
