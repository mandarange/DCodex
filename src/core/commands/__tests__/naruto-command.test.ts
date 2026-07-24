import test from 'node:test'
import assert from 'node:assert/strict'
import { renderNarutoBlockedLines } from '../naruto-command.js'

test('Naruto blocked output prioritizes one actionable reason and redacts unsafe detail', () => {
  const lines = renderNarutoBlockedLines([
    'host_capability_spreadsheet_final_artifact_missing',
    'Error: raw MCP response token=secret /Users/operator/project',
    'host_capability_unhealthy:host.spreadsheet.workbook.v1',
    'host_tool_call_not_allowed:spreadsheet_update'
  ])
  const output = lines.join('\n')

  assert.deepEqual(lines, [
    '상태: 차단',
    '이유: 현재 에이전트에 엑셀 수정 도구가 허용되지 않았습니다.',
    '조치: ACAS 에이전트 도구 권한에서 spreadsheet_update를 허용한 뒤 같은 요청을 다시 실행하세요.',
    '코드: host_tool_call_not_allowed:spreadsheet_update'
  ])
  assert.doesNotMatch(output, /raw MCP|token=|\/Users\/|secret/)
})
