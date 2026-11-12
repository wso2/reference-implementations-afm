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


import { type ChangeEvent, type DragEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { IMAGE_ACCEPT, MAX_IMAGES_PER_MESSAGE, pickImages } from "../../core/files/images";
import { type ImageAttachment } from "../../core/runtime/protocol";
import { Icon } from "../../ui/Icon";
import { createSerialQueue, useAutosize } from "../../ui/hooks";
import { HIDDEN_FILE_INPUT, sendsOnEnter } from "../../ui/inputs";

const MAX_HEIGHT = 180;
const FEEDBACK_MS = 5000;

interface Props {
  onSend: (text: string, images?: ImageAttachment[]) => void;
  onStop: () => void;
  streaming: boolean;
  disabled: boolean;
  placeholder?: string;
}

interface SkippedImage {
  name: string;
  reason: string;
}

const LISTED = 3;

function nameList(names: string[]): string {
  if (names.length <= LISTED) return names.join(", ");
  return `${names.slice(0, LISTED).join(", ")} and ${names.length - LISTED} more`;
}

// Sending waits while pictures are still being prepared, so a picture the person just chose is not left behind.
export function canSend(
  text: string,
  imageCount: number,
  block: { disabled: boolean; streaming: boolean; preparing: boolean },
): boolean {
  if (block.disabled || block.streaming || block.preparing) return false;
  return text.trim().length > 0 || imageCount > 0;
}

export function attachFeedback(attached: string[], skipped: SkippedImage[]): string | null {
  const sentences: string[] = [];
  if (attached.length > 0) sentences.push(`Attached ${nameList(attached)}.`);
  for (const file of skipped.slice(0, 2)) sentences.push(`${file.name} ${file.reason.replace(/\.+$/, "")}.`);
  if (skipped.length > 2) sentences.push(`${skipped.length - 2} more skipped.`);
  return sentences.length === 0 ? null : sentences.join(" ");
}

function useImages() {
  const [dragOver, setDragOver] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; problem: boolean } | null>(null);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const cleared = useRef(0);
  // Pictures are prepared one selection at a time, and counted as they are added, so two selections made close together
  // cannot both take the free places.
  const [enqueue] = useState(createSerialQueue);
  const staged = useRef(0);
  const [preparing, setPreparing] = useState(0);

  useEffect(() => {
    if (feedback === null || feedback.problem) return;
    const timer = setTimeout(() => setFeedback(null), FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [feedback]);

  function addImages(files: File[]) {
    if (files.length === 0) return;
    const clearedBefore = cleared.current;
    setPreparing((count) => count + 1);
    enqueue(async () => {
      try {
        // The message was sent before this selection began, or while its pictures were still being prepared.
        // They belong to no message now.
        if (cleared.current !== clearedBefore) return;
        const { attached, skipped } = await pickImages(files, staged.current);
        if (cleared.current !== clearedBefore) return;
        staged.current += attached.length;
        if (attached.length > 0) setImages((current) => [...current, ...attached]);
        const text = attachFeedback(
          attached.map((image) => image.name),
          skipped,
        );
        setFeedback(text === null ? null : { text, problem: skipped.length > 0 });
      } finally {
        setPreparing((count) => count - 1);
      }
    });
  }

  function onPicked(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files !== null) void addImages(Array.from(event.target.files));
    event.target.value = "";
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(true);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(false);
    void addImages(Array.from(event.dataTransfer.files));
  }

  return {
    images,
    dragOver,
    preparing: preparing > 0,
    status: preparing > 0 ? "Preparing pictures…" : (feedback?.text ?? ""),
    onPicked,
    onDragOver,
    onDragLeave: () => setDragOver(false),
    onDrop,
    removeImage: (index: number) => {
      staged.current = Math.max(0, staged.current - 1);
      setImages((current) => current.filter((_, at) => at !== index));
    },
    clear: () => {
      cleared.current += 1;
      staged.current = 0;
      setFeedback(null);
      setImages([]);
    },
  };
}

function ImageButton({ disabled, full, onPicked }: { disabled: boolean; full: boolean; onPicked: (event: ChangeEvent<HTMLInputElement>) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className="xc-cbtn"
        aria-label="Attach an image"
        data-tip={full ? `Up to ${MAX_IMAGES_PER_MESSAGE} images per message` : "Attach an image"}
        disabled={disabled || full}
        onClick={() => input.current?.click()}
      >
        <Icon
          size={18}
          weight={2}
          path="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"
        />
      </button>
      <input ref={input} type="file" multiple accept={IMAGE_ACCEPT} {...HIDDEN_FILE_INPUT} onChange={onPicked} />
    </>
  );
}

function ImageRow({ images, onRemove }: { images: ImageAttachment[]; onRemove: (index: number) => void }) {
  return (
    <div className="composer-image-row" role="group" aria-label="Attached images">
      {images.map((image, index) => (
        <div className="composer-image-chip" key={`${image.name}-${index}`}>
          <img src={`data:${image.mediaType};base64,${image.data}`} alt={image.name} />
          <button
            type="button"
            className="composer-image-remove"
            onClick={() => onRemove(index)}
            aria-label={`Remove ${image.name}`}
            data-tip="Remove this image"
          >
            <Icon size={10} weight={3} path="M18 6 6 18M6 6l12 12" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Composer({ onSend, onStop, streaming, disabled, placeholder }: Props) {
  const [text, setText] = useState("");
  const ref = useAutosize(text, MAX_HEIGHT);
  const picker = useImages();
  const { images, status } = picker;
  const sendable = canSend(text, images.length, { disabled, streaming, preparing: picker.preparing });

  function submit() {
    if (!sendable) return;
    onSend(text.trim(), images.length > 0 ? images : undefined);
    picker.clear();
    setText("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (sendsOnEnter(event)) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="xc-dock" onDragOver={picker.onDragOver} onDragLeave={picker.onDragLeave} onDrop={picker.onDrop}>
      {picker.dragOver && (
        <div className="composer-drop-overlay">
          <span>Drop to attach an image</span>
        </div>
      )}
      {status !== "" && (
        <div className="composer-attach-status" aria-hidden="true">
          {status}
        </div>
      )}
      <span className="visually-hidden" role="status">
        {status}
      </span>
      {images.length > 0 && <ImageRow images={images} onRemove={picker.removeImage} />}
      <div className="xc-col">
        <div className="xc-composer">
          <ImageButton disabled={disabled} full={images.length >= MAX_IMAGES_PER_MESSAGE} onPicked={picker.onPicked} />
          <textarea
            className="xc-field"
            ref={ref}
            rows={1}
            value={text}
            disabled={disabled}
            aria-label="Message the agent"
            placeholder={
              placeholder ??
              (disabled ? "Load an agent first…" : streaming ? "Agent is responding…" : "Message the agent…")
            }
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {streaming ? (
            <button className="xc-stop" onClick={onStop} aria-label="Stop" data-tip="Stop">
              <i aria-hidden="true" />
            </button>
          ) : (
            <button
              className={`xc-send ${sendable ? "" : "off"}`}
              onClick={submit}
              disabled={!sendable}
              aria-label="Send"
            >
              <Icon weight={2.3} path="m5 12 7-7 7 7M12 19V5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
