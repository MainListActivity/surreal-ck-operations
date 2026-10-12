#!/usr/bin/env python3
"""Read-only byte extraction. Output goes only to an explicitly supplied evidence directory."""
import sys
from pathlib import Path
parts = [
 ('free', '/** 供应商账户计划类型读回常量：reviewed-token-plan 文档只接受 FREE，非 FREE 值不过校验。 */\n', 'export const TOKEN_PLAN_PLAN_TYPE_FREE = "TOKEN_PLAN_PLAN_TYPE_FREE";\n'),
 ('helpers', 'const boundedRef = ', 'const model = z.string().max(128).regex(/^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*(?![\\s\\S])/);\n'),
 ('evidence', '/** 三种证据文档共用的服务标识与采样窗口字段；余额与配额字段按 type 判别，互不混入。 */\n', 'export type ReviewedEvidence = z.infer<typeof reviewedEvidenceSchema>;\n'),
]
source = Path(sys.argv[1]).read_bytes()
out = Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
blocks=[]
for name,start,end in parts:
 start=start.encode(); end=end.encode()
 if source.count(start)!=1 or source.count(end)!=1:
  raise SystemExit('missing or duplicate region anchors: '+name)
 a=source.index(start); z=source.index(end,a)+len(end)
 part=source[a:z]; (out/(name+'.ts')).write_bytes(part); blocks.append(part)
(out/'mirror.ts').write_bytes(b''.join(blocks))
