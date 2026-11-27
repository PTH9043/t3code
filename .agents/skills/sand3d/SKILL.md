---
name: sand3d
description: On-demand 3D-as-Code modeling and multi-format export (GLB, URDF, USDA, IFC, OBJ, STL) using Sandflow AI Sand3D (Apache-2.0) in an isolated Python 3.11/3.13 uv environment. Load only when a task explicitly involves 3D geometry, CAD parts, articulated URDF/robotics assets, or Blender script generation.
---

# Sand3D On-Demand 3D-as-Code Skill

이 스킬은 3D 모델링·CAD·URDF·GLB 내보내기 요청이 있을 때만 온디맨드로 로드하여 기본 시스템 프롬프트 토큰을 0으로 유지합니다.

## 환경 제약 (필수 준수)

- **`bpy` 휠은 Python 3.12를 지원하지 않습니다.** 반드시 `uv venv --python 3.11`(bpy 4.5 LTS, 이 PC 기본 설치 `Python 3.11.9` 즉시 호환) 또는 `--python 3.13`(bpy 5.2 LTS) 격리 가상환경에서만 실행합니다.
- PowerShell 실행 금지: `uv` / `python` 실행은 CMD 또는 Python `subprocess.run`으로 호출합니다.

## 핵심 작성 규율

1. 좌표 수작업 계산 대신 Sand3D의 이름 기반 참조(`Frame`, `face`, `edge`, `snap`, `joint`)와 평탄화 동사(`s3d.extrude`, `s3d.revolve`, `s3d.hole`, `s3d.fillet`)를 사용합니다(일반 `bpy` 대비 토큰 ~4배 절감).
2. 내보내기 포맷은 요청 목적에 맞게 `s3d.export()`로 생성합니다:
   - 웹/게임/미리보기: `.glb`
   - 로봇 시뮬레이션(ROS/MuJoCo/Isaac): `.urdf`
   - Omniverse: `.usda` / BIM: `.ifc` / 3D 프린팅: `.obj`, `.stl`
3. 생성한 임시 스크립트와 중간 캐시는 작업 종료 시 반드시 정리하고 최종 요청 산출물만 남깁니다.
