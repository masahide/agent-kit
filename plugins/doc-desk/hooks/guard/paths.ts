/**
 * 回答待ちの間に書き込みを止めるパスの正規化と照合 (`tool.check` のフックが使います)。
 *
 * モジュールには Node が無いので、パスの処理は文字列で行います。
 */

const DRIVE = /^[A-Za-z]:\//

/**
 * Windows のパスか (ドライブ名で始まるか、区切りが `\`)。Windows では大文字小文字を区別しません。
 */
export const isWindowsPath = (path: string): boolean => DRIVE.test(path.replace(/\\/g, '/')) || path.includes('\\')

/**
 * パスを比べられる形にします: `\` を `/` に、cwd 基準の絶対パスに、`.` と `..` を解決し、
 * 末尾の `/` を外します。Windows (cwd かパスが Windows の形) では小文字にします。
 *
 * @param path `Write` などの入力の `file_path`、質問票の `source` など
 * @param cwd セッションの cwd (絶対)
 */
export function normalizePath(path: string, cwd: string): string {
  const slashed = path.replace(/\\/g, '/')
  const base = cwd.replace(/\\/g, '/')
  const isAbsolute = slashed.startsWith('/') || DRIVE.test(slashed)
  const joined = isAbsolute ? slashed : `${base.replace(/\/+$/, '')}/${slashed}`

  const drive = DRIVE.exec(joined)?.[0].slice(0, 2) ?? ''
  const segments: string[] = []
  for (const segment of joined.slice(drive.length).split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  const normalized = `${drive}/${segments.join('/')}`
  return isWindowsPath(cwd) || isWindowsPath(path) ? normalized.toLowerCase() : normalized
}

/**
 * ツールの入力から書き込み先のパスを取り出します (`Write` と `Edit` は `file_path`、`NotebookEdit` は `notebook_path`)。
 */
export function writeTargetOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) {
    return null
  }
  const { file_path: filePath, notebook_path: notebookPath } = input as { file_path?: unknown; notebook_path?: unknown }
  if (typeof filePath === 'string' && filePath !== '') {
    return filePath
  }
  if (typeof notebookPath === 'string' && notebookPath !== '') {
    return notebookPath
  }
  return null
}

/**
 * 2 つのパスの綴りの集まり (正規化した綴りと、あれば realPath) が 1 つでも重なるか。
 */
export const isSamePath = (a: readonly string[], b: readonly string[]): boolean => a.some(path => b.includes(path))
