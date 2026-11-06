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
import {
  type CollectedFile,
  type CollectResult,
  collectFromDataTransfer,
  collectFromFileList,
  IMAGE_ACCEPT,
  MAX_FILES,
  MAX_IMAGES_PER_MESSAGE,
  pickImages,
  splitDropped,
  supportsDirectoryDrop,
} from "../../core/files/attachments";
import { type ImageAttachment } from "../../core/runtime/protocol";
import { Icon } from "../../ui/Icon";
import { useAutosize, useDismiss } from "../../ui/hooks";
import { HIDDEN_FILE_INPUT } from "../../ui/inputs";
import { useVoiceInput } from "./voice";

const MAX_HEIGHT = 180;

interface AttachOutcome {
  attached: string[];
  skipped: { name: string; reason: string }[];
}

interface Props {
  onSend: (text: string, images?: ImageAttachment[]) => void;
  onStop: () => void;
  onAttach: (files: CollectedFile[]) => Promise<AttachOutcome>;
  streaming: boolean;
  disabled: boolean;
  placeholder?: string;
}

function useAttachments(onAttach: Props["onAttach"]) {
  const [attaching, setAttaching] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; problem: boolean } | null>(null);
  const [images, setImages] = useState<ImageAttachment[]>([]);

  useEffect(() => {
    if (feedback === null || feedback.problem) return;
    const timer = setTimeout(() => setFeedback(null), 5000);
    return () => clearTimeout(timer);
  }, [feedback]);

  function report(attached: string[], skipped: SkippedFile[]) {
    const text = attachFeedback(attached, skipped);
    setFeedback(text === null ? null : { text, problem: skipped.length > 0 });
  }

  async function runAttach({ files, truncated }: CollectResult) {
    if (files.length === 0) return;
    setAttaching(files.length);
    try {
      const outcome = await onAttach(files);
      const leftOut = { name: `Files beyond the first ${MAX_FILES}`, reason: "were not attached" };
      report(outcome.attached, truncated ? [...outcome.skipped, leftOut] : outcome.skipped);
    } finally {
      setAttaching(0);
    }
  }

  async function runImagePick(files: File[]) {
    if (files.length === 0) return;
    const { attached, skipped } = await pickImages(files, images.length);
    if (attached.length > 0) setImages((prev) => [...prev, ...attached]);
    report(
      attached.map((image) => image.name),
      skipped,
    );
  }

  function onFilesPicked(event: ChangeEvent<HTMLInputElement>) {
    const list = event.target.files;
    if (list !== null) void runAttach(collectFromFileList(list));
    event.target.value = "";
  }

  function onImagesPicked(event: ChangeEvent<HTMLInputElement>) {
    const list = event.target.files;
    if (list !== null) void runImagePick(Array.from(list));
    event.target.value = "";
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(true);
  }

  function routeDropped({ files, truncated }: CollectResult) {
    const { images: imageFiles, others } = splitDropped(files);
    if (imageFiles.length > 0) void runImagePick(imageFiles);
    if (others.length > 0) void runAttach({ files: others, truncated });
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(false);
    const items = event.dataTransfer.items;
    const flatFiles = event.dataTransfer.files;
    if (supportsDirectoryDrop(items)) {
      void collectFromDataTransfer(items).then((result) =>
        routeDropped(result.files.length > 0 ? result : collectFromFileList(flatFiles)),
      );
    } else {
      routeDropped(collectFromFileList(flatFiles));
    }
  }

  return {
    images,
    dragOver,
    status: attaching > 0 ? `Reading ${attaching === 1 ? "the file" : `${attaching} files`}…` : (feedback?.text ?? ""),
    onFilesPicked,
    onImagesPicked,
    onDragOver,
    onDragLeave: () => setDragOver(false),
    onDrop,
    removeImage: (index: number) => setImages((prev) => prev.filter((_, i) => i !== index)),
    clear: () => {
      setFeedback(null);
      setImages([]);
    },
  };
}

interface AttachMenuProps {
  disabled: boolean;
  imagesFull: boolean;
  onFilesPicked: (event: ChangeEvent<HTMLInputElement>) => void;
  onImagesPicked: (event: ChangeEvent<HTMLInputElement>) => void;
}

function AttachMenu({ disabled, imagesFull, onFilesPicked, onImagesPicked }: AttachMenuProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const imagesInputRef = useRef<HTMLInputElement>(null);

  useDismiss(open, anchorRef, () => setOpen(false));

  const options = [
    { label: "Attach files (PDF, MD, TXT)", input: filesInputRef, disabled: false },
    { label: "Attach a folder", input: folderInputRef, disabled: false },
    { label: "Attach an image", input: imagesInputRef, disabled: imagesFull },
  ];

  return (
    <div className="composer-attach-menu-anchor" ref={anchorRef}>
      <button
        type="button"
        className="xc-cbtn"
        aria-label="Attach files, a folder, or an image"
        data-tip="Attach files, a folder, or an image"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon
          size={18}
          weight={2}
          path="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"
        />
      </button>
      {open && (
        <div className="composer-attach-menu">
          {options.map(({ label, input, disabled: unavailable }) => (
            <button
              type="button"
              key={label}
              disabled={unavailable}
              onClick={() => {
                setOpen(false);
                input.current?.click();
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <input
        ref={filesInputRef}
        type="file"
        multiple
        accept=".pdf,.md,.markdown,.txt"
        {...HIDDEN_FILE_INPUT}
        onChange={onFilesPicked}
      />
      <input
        ref={folderInputRef}
        type="file"
        {...{ webkitdirectory: "" }}
        {...HIDDEN_FILE_INPUT}
        onChange={onFilesPicked}
      />
      <input
        ref={imagesInputRef}
        type="file"
        multiple
        accept={IMAGE_ACCEPT}
        {...HIDDEN_FILE_INPUT}
        onChange={onImagesPicked}
      />
    </div>
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

export function Composer({ onSend, onStop, onAttach, streaming, disabled, placeholder }: Props) {
  const [text, setText] = useState("");
  const ref = useAutosize(text, MAX_HEIGHT);
  const voiceBaseTextRef = useRef("");
  const attachments = useAttachments(onAttach);
  const { images, status } = attachments;

  const voice = useVoiceInput((liveTranscript) => {
    const base = voiceBaseTextRef.current;
    setText(base === "" ? liveTranscript : `${base} ${liveTranscript}`);
  });

  function toggleVoice() {
    if (voice.listening) {
      voice.stop();
      return;
    }
    voiceBaseTextRef.current = text.trim();
    voice.start();
    ref.current?.focus();
  }

  function submit() {
    const trimmed = text.trim();
    if ((trimmed.length === 0 && images.length === 0) || disabled || streaming) return;
    onSend(trimmed, images.length > 0 ? images : undefined);
    attachments.clear();
    setText("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  const empty = text.trim().length === 0 && images.length === 0;

  return (
    <div
      className="xc-dock"
      onDragOver={attachments.onDragOver}
      onDragLeave={attachments.onDragLeave}
      onDrop={attachments.onDrop}
    >
      {attachments.dragOver && (
        <div className="composer-drop-overlay">
          <span>Drop to attach (PDF, Markdown, text, or an image)</span>
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
      {images.length > 0 && <ImageRow images={images} onRemove={attachments.removeImage} />}
      <div className="xc-col">
        <div className="xc-composer">
          <AttachMenu
            disabled={disabled}
            imagesFull={images.length >= MAX_IMAGES_PER_MESSAGE}
            onFilesPicked={attachments.onFilesPicked}
            onImagesPicked={attachments.onImagesPicked}
          />
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
          {voice.supported && (
            <button
              type="button"
              className={`xc-cbtn ${voice.listening ? "listening" : ""}`}
              onClick={toggleVoice}
              disabled={disabled}
              aria-label={voice.listening ? "Stop dictation" : "Dictate a message"}
              data-tip={voice.listening ? "Stop dictation" : "Dictate a message"}
            >
              <Icon size={18} weight={2}>
                <path d="M12 19v3" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <rect x="9" y="2" width="6" height="13" rx="3" />
              </Icon>
            </button>
          )}
          {streaming ? (
            <button className="xc-stop" onClick={onStop} aria-label="Stop" data-tip="Stop">
              <i aria-hidden="true" />
            </button>
          ) : (
            <button
              className={`xc-send ${disabled || empty ? "off" : ""}`}
              onClick={submit}
              disabled={disabled || empty}
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

interface SkippedFile {
  name: string;
  reason: string;
}

const LISTED = 3;

function nameList(names: string[]): string {
  if (names.length <= LISTED) return names.join(", ");
  return `${names.slice(0, LISTED).join(", ")} and ${names.length - LISTED} more`;
}

export function attachFeedback(attached: string[], skipped: SkippedFile[]): string | null {
  const sentences: string[] = [];
  if (attached.length > 0) sentences.push(`Attached ${nameList(attached)}.`);
  for (const file of skipped.slice(0, 2)) sentences.push(`${file.name} ${file.reason.replace(/\.+$/, "")}.`);
  if (skipped.length > 2) sentences.push(`${skipped.length - 2} more skipped.`);
  return sentences.length === 0 ? null : sentences.join(" ");
}
