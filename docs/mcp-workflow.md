# /site Skill과 MCP 연결

이 예시는 Claude Code에서 `/site`를 호출하면 승인 근거를 조회하고, AI 분석 결과를 초안 또는 분석 이력으로 남기는 구조다. AI 모델은 이 프로젝트에 포함하지 않는다. 실제 Claude Code 연결과 분석 품질은 별도 확인 대상이다.

## 설치 예시

1. 로컬 웹 앱을 실행해 가상 자료를 준비한다. MCP 프로세스에는 암호화 키를 전달하지 않는다.
2. `examples/.mcp.json.example`을 작업 프로젝트의 `.mcp.json`으로 복사한 뒤 Node·프로젝트·데이터 폴더 경로를 실제 절대 경로로 변경한다. `SITE_REGISTRY_SITE`는 한 사이트의 코드로 고정한다. 가상 예시는 `SITE_REGISTRY_DEMO: "1"`을 사용한다.
3. `examples/site/SKILL.md`를 해당 프로젝트의 `.claude/skills/site/SKILL.md`로 복사한다. Skill 이름이 `site`이므로 `/site`로 호출한다.
4. Claude Code에서 연결을 확인하고 `/site 요구사항 …` 또는 `/site 초안 …`으로 실행한다. 도구 사용 승인 설정은 사용자가 확인한다.

## 노출하는 도구

| 도구 | 읽기 / 쓰기 | 범위 |
|---|---|---|
| `list_sites` | 읽기 | 연결한 사이트 한 곳의 기본 정보 |
| `get_site_context` | 읽기 | 승인된 근거·검토 기준과 공개 배치 정보 |
| `get_feature_map` | 읽기 | 승인된 기능 정의와 관계 |
| `save_evidence_draft` | 쓰기 | 같은 사이트의 새 근거 초안 또는 수정 초안 |
| `record_analysis` | 쓰기 | 사용한 승인 근거 버전을 연결한 분석 이력 |

MCP 쓰기는 초안·분석 추가에 한정한다. 승인, 설정값 복호화, 키·배치 관리, 운영 시스템 실행 도구는 제공하지 않는다. 입력은 허용한 필드만 받으므로 `site_id`, `status`, `approved` 등을 추가해 동작을 변경할 수 없다. 수정은 최신 저장 버전을 지정해야 하며 충돌하면 다시 확인한다.

## 신뢰 경계

- **사람:** 로컬 웹에서 근거의 특정 버전을 검토·승인한다.
- **MCP:** 고정 사이트의 승인 자료를 제공하고 초안·분석을 기록한다. 암호화 키는 읽지 않는다.
- **Skill:** 근거를 해석할 검토 절차를 안내한다. 승인이나 보안 정책을 강제하는 실행 엔진은 아니다.
- **AI:** 등록 근거와 확인 가능한 코드를 분석한다. 결과는 사람이 검토할 대상이다.

MCP 프로세스는 초안·분석 저장을 위해 SQLite 파일 쓰기 권한을 갖는다. 도구 경계의 제한이며, OS에서 같은 파일에 직접 접근할 수 있는 프로그램까지 격리하는 구조는 아니다. 이 예시는 단일 사용자 로컬 시연용이다.

## 준거 문서

- [MCP 2025-11-25 Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools): 도구 목록·호출·입력 스키마·결과 형식.
- [MCP 2025-11-25 stdio](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports): 표준 입출력으로 한 줄씩 JSON-RPC 메시지를 전달.
- [Claude Code Skills](https://code.claude.com/docs/en/skills): `.claude/skills/<name>/SKILL.md`와 `/skill-name` 호출.

이 구현은 위 버전의 초기화와 5개 도구에 필요한 작은 stdio 범위다. 전체 MCP 규격 적합성이나 Claude 실연동을 검증했다고 주장하지 않는다.
