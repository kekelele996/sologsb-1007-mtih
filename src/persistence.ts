import { createSeedProject, makeSpeaker, uid } from "./data";
import type { PersistedEnvelope, ProjectData, Segment, Speaker, TranscriptTrack } from "./types";

export const STORAGE_KEY = "sologsb-1007-project-v1";
export const SESSION_KEY = "sologsb-1007-session";

/**
 * 归一化旧草稿：早期版本把导入片段统一指向未登记的 "sp-custom"，
 * 也可能缺少 speakers 数组或片段字段。这里补齐结构并为悬空引用
 * 登记占位发言人，保证旧草稿打开后每个片段都有合法身份。
 */
export function normalizeProject(project: ProjectData): ProjectData {
  const speakers = Array.isArray(project.speakers) ? [...project.speakers] : [];
  if (!speakers.length) speakers.push(makeSpeaker("未命名发言人", 0));
  const known = new Set(speakers.map((speaker) => speaker.id));
  const missing: string[] = [];
  for (const track of project.tracks ?? []) {
    for (const segment of track.segments ?? []) {
      segment.tagIds ??= [];
      segment.comments ??= [];
      segment.flags = {
        lowConfidence: segment.flags?.lowConfidence ?? false,
        dialect: segment.flags?.dialect ?? false,
        properNoun: segment.flags?.properNoun ?? false,
      };
      if (segment.speakerId && !known.has(segment.speakerId) && !missing.includes(segment.speakerId)) {
        missing.push(segment.speakerId);
      }
    }
  }
  missing.forEach((id, index) => {
    speakers.push({ ...makeSpeaker(`待确认发言人 ${index + 1}`, speakers.length + index), id });
  });
  return { ...project, speakers };
}

export function loadProject(): { project: ProjectData; revision: number } {
  if (typeof localStorage === "undefined") {
    return { project: createSeedProject(), revision: 0 };
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as PersistedEnvelope;
    if (parsed?.schema === 1 && parsed.project?.tracks?.length) {
      return { project: normalizeProject(parsed.project), revision: parsed.revision ?? 0 };
    }
  } catch {
    // A malformed local draft falls back to the bundled sample.
  }
  return { project: createSeedProject(), revision: 0 };
}

export function saveProject(project: ProjectData, revision: number, tabId: string) {
  const envelope: PersistedEnvelope = {
    schema: 1,
    revision,
    tabId,
    savedAt: Date.now(),
    project,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  return envelope;
}

export function readEnvelope(): PersistedEnvelope | null {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as PersistedEnvelope;
  } catch {
    return null;
  }
}

export function downloadText(filename: string, content: string, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function formatTime(seconds: number, withMillis = true) {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  const head = [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":");
  return withMillis ? `${head}.${String(ms).padStart(3, "0")}` : head;
}

export function parseTime(value: string) {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(normalized) || 0;
}

/**
 * 解析 SRT / VTT / `[00:12] 文本` 导入内容。
 * 按发言人姓名登记身份：同名复用已有 id，新姓名创建发言人并随结果返回，
 * 避免多人访谈被并成同一身份。
 */
export function parseTimedTranscript(
  input: string,
  trackName: string,
  existingSpeakers: Speaker[],
): { track: TranscriptTrack; newSpeakers: Speaker[] } {
  const byName = new Map(existingSpeakers.map((speaker) => [speaker.name, speaker.id]));
  const newSpeakers: Speaker[] = [];
  const fallbackId =
    existingSpeakers.find((speaker) => speaker.id === "sp-interviewer")?.id ?? existingSpeakers[0]?.id ?? "";
  const resolveSpeaker = (rawName?: string) => {
    const name = rawName?.trim();
    if (!name) return fallbackId;
    const known = byName.get(name);
    if (known) return known;
    const speaker = makeSpeaker(name, existingSpeakers.length + newSpeakers.length);
    byName.set(name, speaker.id);
    newSpeakers.push(speaker);
    return speaker.id;
  };
  const blankSegment = (): Segment => ({
    id: uid("seg"),
    start: 0,
    end: 1,
    speakerId: fallbackId,
    text: "",
    confidence: 3,
    reviewed: false,
    flags: { lowConfidence: false, dialect: false, properNoun: false },
    tagIds: [],
    comments: [],
  });

  const blocks = input.trim().split(/\n\s*\n/);
  const segments: Segment[] = [];
  const srtPattern = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;
  const bracketPattern = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–]?\s*(.*)$/;

  for (const rawBlock of blocks) {
    const lines = rawBlock.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const srtIndex = lines.findIndex((line) => srtPattern.test(line));
    if (srtIndex >= 0) {
      const match = srtPattern.exec(lines[srtIndex]);
      const text = lines.slice(srtIndex + 1).join(" ");
      const speakerName = text.match(/^([^：:]{1,10})[：:]/)?.[1];
      segments.push({
        ...blankSegment(),
        start: parseTime(match?.[1] ?? "0"),
        end: parseTime(match?.[2] ?? "1"),
        speakerId: resolveSpeaker(speakerName),
        text: text.replace(/^[^：:]{1,10}[：:]\s*/, ""),
      });
      continue;
    }
    for (const line of lines) {
      const match = bracketPattern.exec(line);
      if (!match) continue;
      const start = parseTime(match[1]);
      const text = match[2];
      const speakerName = text.match(/^([^：:]{1,10})[：:]/)?.[1];
      segments.push({
        ...blankSegment(),
        start,
        end: start + Math.max(3, text.length / 5),
        speakerId: resolveSpeaker(speakerName),
        text: text.replace(/^[^：:]{1,10}[：:]\s*/, ""),
      });
    }
  }

  if (!segments.length && input.trim()) {
    input.split("\n").map((line) => line.trim()).filter(Boolean).forEach((text, index) => {
      segments.push({
        ...blankSegment(),
        start: index * 6,
        end: index * 6 + 5.4,
        text,
      });
    });
  }

  return {
    track: {
      id: uid("track"),
      name: trackName || "导入轨",
      language: "待识别",
      status: "待校对",
      segments,
    },
    newSpeakers,
  };
}
