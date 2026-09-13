import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('release archive publication', () => {
  it('preserves selected history, fails closed, and never overwrites existing archives', () => {
    const result = execFileSync('python3', ['-m', 'unittest', 'discover', '-s', 'test/python', '-p', 'test_release_archive.py'], {
      encoding: 'utf8', cwd: process.cwd(), timeout: 20_000
    })
    expect(result).toContain('Published v2.0.0')
  })
})
