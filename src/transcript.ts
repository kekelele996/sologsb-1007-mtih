import { uid } from "./data";
import { parseTime } from "./persistence";
import type { ProjectData, Segment, Speaker, TranscriptTrack } from "./types";

export const SPEAKER_COLORS = ["#2563eb", "#be185d", "#0f766e", "#b45309", "#7c3aed", "#dc2626", "#15803d", "#9333ea"];

/** Find a speaker by exact name, or register a new one; unnamed segments fall back to the interviewer. */
export function ensureSpeakerId(draft: ProjectData, name?: string): string {
  const trimmed = name?.trim() ?? "";
  if (trimmed) {
    const existing = draft.speakers.find((speaker) => speaker.name === trimmed);
    if (existing) return existing.id;
    const created: Speaker = {
      id: uid("sp"),
      name: trimmed,
      role: "待确认",
      color: SPEAKER_COLORS[draft.speakers.length % SPEAKER_COLORS.length],
    };
    draft.speakers.push(created);
    return created.id;
  }
  const fallback = draft.speakers.find((speaker) => speaker.id === "sp-interviewer") ?? draft.speakers[0];
  return fallback ? fallback.id : ensureSpeakerId(draft, "采访者");
}

export interface ParsedTranscript {
  track: TranscriptTrack;
  /** segment id -> speaker name parsed from a "姓名：" prefix */
  speakerNames: Record<string, string>;
}

export function parseTimedTranscript(input: string, trackName: string): ParsedTranscript {
  const blocks = input.trim().split(/\n\s*\n/);
  const segments: Segment[] = [];
  const speakerNames: Record<string, string> = {};
  const srtPattern = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;
  const bracketPattern = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–]?\s*(.*)$/;

  const pushSegment = (start: number, end: number, rawText: string) => {
    const speakerName = rawText.match(/^([^：:]{1,10})[：:]/)?.[1]?.trim();
    const segment: Segment = {
      id: uid("seg"),
      start,
      end,
      speakerId: "",
      text: rawText.replace(/^[^：:]{1,10}[：:]\s*/, ""),
      confidence: 3,
      reviewed: false,
      flags: { lowConfidence: false, dialect: false, properNoun: false },
      tagIds: [],
      comments: [],
    };
    if (speakerName) speakerNames[segment.id] = speakerName;
    segments.push(segment);
  };

  for (const rawBlock of blocks) {
    const lines = rawBlock.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const srtIndex = lines.findIndex((line) => srtPattern.test(line));
    if (srtIndex >= 0) {
      const match = srtPattern.exec(lines[srtIndex]);
      const text = lines.slice(srtIndex + 1).join(" ");
      pushSegment(parseTime(match?.[1] ?? "0"), parseTime(match?.[2] ?? "1"), text);
      continue;
    }
    for (const line of lines) {
      const match = bracketPattern.exec(line);
      if (!match) continue;
      const start = parseTime(match[1]);
      const text = match[2];
      pushSegment(start, start + Math.max(3, text.length / 5), text);
    }
  }

  if (!segments.length && input.trim()) {
    input.split("\n").map((line) => line.trim()).filter(Boolean).forEach((text, index) => {
      pushSegment(index * 6, index * 6 + 5.4, text);
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
    speakerNames,
  };
}

/** Reassign every segment on every track from one speaker to another and drop the source identity. */
export function mergeSpeakerInto(draft: ProjectData, sourceId: string, targetId: string): void {
  for (const track of draft.tracks) {
    for (const segment of track.segments) {
      if (segment.speakerId === sourceId) segment.speakerId = targetId;
    }
  }
  draft.speakers = draft.speakers.filter((speaker) => speaker.id !== sourceId);
}

/** Count segments across all tracks that still reference a speaker. */
export function countSpeakerUsage(project: ProjectData, speakerId: string): number {
  return project.tracks.reduce(
    (total, track) => total + track.segments.filter((segment) => segment.speakerId === speakerId).length,
    0,
  );
}
