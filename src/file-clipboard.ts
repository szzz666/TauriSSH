import { create } from "./tiny-store";

export interface ClipboardEntry {
  path: string;
  fileName: string;
  name: string;
  type: string;
}

interface FileClipboardState {
  connectionId: string | null;
  mode: "copy" | "cut" | null;
  entries: ClipboardEntry[];
}

export const useFileClipboard = create<FileClipboardState>(() => ({
  connectionId: null,
  mode: null,
  entries: [],
}));
