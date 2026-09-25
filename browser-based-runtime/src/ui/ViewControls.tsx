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

interface Segment<T extends string> {
  id: T;
  label: string;
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className = "",
}: {
  options: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <span className={`u-seg ${className}`} role="tablist" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.id}
          role="tab"
          aria-selected={value === option.id}
          className={value === option.id ? "on" : ""}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}

export type EditorMode = "simple" | "raw";

const MODE_SEGMENTS: Segment<EditorMode>[] = [
  { id: "simple", label: "Build" },
  { id: "raw", label: "Raw" },
];

export function ModeSwitch({ mode, onMode }: { mode: EditorMode; onMode: (mode: EditorMode) => void }) {
  return <Segmented options={MODE_SEGMENTS} value={mode} onChange={onMode} ariaLabel="Diagram or file" />;
}

export type WriteMode = "rich" | "raw";

const WRITE_SEGMENTS: Segment<WriteMode>[] = [
  { id: "rich", label: "Rich text" },
  { id: "raw", label: "Raw" },
];

export function WriteModeSwitch({ mode, onMode }: { mode: WriteMode; onMode: (mode: WriteMode) => void }) {
  return <Segmented options={WRITE_SEGMENTS} value={mode} onChange={onMode} ariaLabel="Formatted text or Markdown" />;
}
