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

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { startBlobWorker } from "./blob-worker";

let started: Promise<void> | null = null;

export function ensurePdfWorker(): Promise<void> {
  started ??= startBlobWorker(new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url)).then(
    (worker) => {
      pdfjsLib.GlobalWorkerOptions.workerPort = worker;
    },
    (error: unknown) => {
      started = null;
      throw error;
    },
  );
  return started;
}
