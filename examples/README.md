# Claude Code 연결 예시

`.mcp.json.example`은 **읽기 전용 연결이 아니다.** 승인 근거를 읽고, 초안(`save_evidence_draft`)과 분석 이력(`record_analysis`)을 저장한다. 승인·키 조회·운영 실행 도구는 없다. 연결 전 `../docs/mcp-workflow.md`의 도구 목록과 경계를 확인한다.

- `.mcp.json.example` → 작업 프로젝트의 `.mcp.json`: 경로와 사이트 코드를 변경한다.
- `site/SKILL.md` → 작업 프로젝트의 `.claude/skills/site/SKILL.md`: `/site` 명령으로 호출한다.
- 예시 연결은 `demo.sqlite`를 사용한다. 일반 데이터에 연결하려면 `SITE_REGISTRY_DEMO`를 `"0"`으로 바꾼다.
- 설정에 암호화 키를 추가하지 않는다. MCP는 키 없이 초안·분석을 저장한다.
- 실제 Claude Code 연결은 자동 테스트와 별도로 확인해야 한다.
