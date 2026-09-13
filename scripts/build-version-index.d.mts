export interface VersionIndexEntry {
  version: string
  tag: string
  archiveUrl: string
  stableHistory?: boolean
}

export interface VersionIndex {
  generatedAt: string
  versions: VersionIndexEntry[]
}

/** Build the rollback version index from `releases/archive/<name>` directory names. */
export function buildVersionIndex(archiveDirNames: string[]): VersionIndex
export function mergeVersionIndex(current: VersionIndex, version: string, stableHistory?: 'keep' | 'retain' | 'unpin'): VersionIndex
