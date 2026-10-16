// Generated from contracts/transcript-result.schema.json by scripts/contracts.sh. Do not edit.
export interface TranscriptResult {
  video_id: string;
  status: "ok" | "no_transcript" | "unavailable" | "blocked";
  lang: string | null;
  source: ("manual" | "auto") | null;
  word_count: number;
  truncated: boolean;
  sponsor_ratio: number | null;
  pages: string[];
}
