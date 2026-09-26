#!/usr/bin/env python3
"""单机 AI 员工队列。GitHub 保存成果/状态，本机锁串行领取与交接。"""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
REPO = 'MainListActivity/surreal-ck-operations'
RUNTIME = ROOT / '.runtime'
META = re.compile(r'<!-- company-task: (.*?) -->')

def gh(*args):
    p = subprocess.run(['gh', *args], text=True, capture_output=True)
    if p.returncode:
        raise RuntimeError(p.stderr.strip())
    return p.stdout.strip()

def issue(n):
    return json.loads(gh('issue', 'view', str(n), '-R', REPO, '--json',
                         'number,title,body,state,labels,comments'))

def names(i):
    return {x['name'] for x in i['labels']}

def metadata(i):
    m = META.search(i['body'])
    if not m:
        raise ValueError('任务缺少 company-task 契约，请交经理分诊')
    return json.loads(m.group(1))

def identity(employee, agent):
    member = json.loads((ROOT / 'agents/registry.json').read_text())['employees'].get(employee)
    if not member or member['agent_id'] != agent or member['status'] != 'active':
        raise ValueError('员工未登记、会话不匹配或未激活')
    return member

def eligible(i, role, employee, action):
    ns = names(i)
    if i['state'] != 'OPEN' or f'role:{role}' not in ns:
        raise ValueError('任务不在自己的开放岗位队列')
    m = metadata(i)
    if action == 'claim' and not ns.intersection({'state:ready', 'state:doing', 'state:review'}):
        raise ValueError('任务不可领取')
    if 'state:review' in ns and m.get('submitted_by') == employee:
        raise ValueError('同一员工不能验收自己的产出，即使更换会话')
    return m

def patch(n, i, state, role, meta):
    body = META.sub('<!-- company-task: ' + json.dumps(meta, ensure_ascii=False) + ' -->', i['body'])
    labels = sorted(x for x in names(i) if not x.startswith(('state:', 'role:')))
    labels += [f'state:{state}', f'role:{role}']
    payload = {'body': body, 'labels': labels}
    if state == 'done':
        payload.update(state='closed', state_reason='completed')
    p = subprocess.run(['gh', 'api', '--method', 'PATCH', f'repos/{REPO}/issues/{n}', '--input', '-'],
                       input=json.dumps(payload), text=True, capture_output=True)
    if p.returncode:
        raise RuntimeError(p.stderr.strip())

def comment(n, employee, agent, delivery, action, body_file, i):
    marker = f'<!-- company-delivery:{delivery}:{action} -->'
    if any(marker in c['body'] for c in i['comments']):
        return
    body = Path(body_file).read_text().strip()
    if len(body) < 40:
        raise ValueError('交付/验收/阻塞证据过短；请填写结果、依据与限制')
    path = RUNTIME / f'{delivery}-{action}.md'
    path.write_text(f'{marker}\n员工：`{employee}`；会话：`{agent}`；动作：`{action}`\n\n{body}\n')
    gh('issue', 'comment', str(n), '-R', REPO, '--body-file', str(path))

@contextlib.contextmanager
def lock():
    RUNTIME.mkdir(exist_ok=True)
    with (RUNTIME / 'queue.lock').open('a') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        yield

def read_leases():
    p = RUNTIME / 'leases.json'
    return json.loads(p.read_text()) if p.exists() else {}

def save_leases(data):
    p = RUNTIME / 'leases.tmp'
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    os.replace(p, RUNTIME / 'leases.json')

def run(a):
    if a.command == 'queue':
        data = json.loads(gh('issue', 'list', '-R', REPO, '--limit', '100', '--label', f'role:{a.role}',
                            '--json', 'number,title,labels,body'))
        for i in data:
            i['labels'] = sorted(names(i))
            try:
                i['contract'] = metadata(i)
            except ValueError:
                i['contract'] = None
            del i['body']
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return
    who = identity(a.employee, a.agent)
    role = who['role']
    with lock():
        leases = read_leases()
        i = issue(a.issue)
        key = str(a.issue)
        if a.command == 'release':
            if role != 'gm' or not a.body_file:
                raise ValueError('只有经理核实旧会话停止并提交接管依据后才能释放')
            comment(a.issue, a.employee, a.agent, uuid.uuid4().hex, 'release', a.body_file, i)
            leases.pop(key, None)
            save_leases(leases)
            print('released; 新执行者需重新 claim')
            return
        current = leases.get(key)
        if current and current['employee'] == a.employee and current['agent'] == a.agent:
            if current.get('released') and current.get('completed_action') == a.command:
                print('already completed; no repeated side effects')
                return
            if current.get('pending') and current['pending']['action'] == a.command:
                pending = current['pending']
                if not a.body_file:
                    raise ValueError('恢复交接需原 --body-file')
                ns = names(i)
                previous = set(pending['previous_labels'])
                destination = {f"state:{pending['state']}", f"role:{pending['role']}"}
                if not (previous.issubset(ns) or destination.issubset(ns)):
                    raise ValueError('远端已发生其他交接，经理核对后恢复，不能覆盖')
                comment(a.issue, a.employee, a.agent, current['delivery'], a.command, a.body_file, i)
                patch(a.issue, i, pending['state'], pending['role'], pending['meta'])
                current.update(released=True, completed_action=a.command)
                current.pop('pending', None)
                save_leases(leases)
                print('recovered handoff')
                return
        m = eligible(i, role, a.employee, 'claim' if a.command == 'claim' else a.command)
        if a.command == 'claim':
            capability = 'review' if 'state:review' in names(i) else 'execute'
            if capability not in who['capabilities'] and role != 'gm':
                raise ValueError('该员工未授予此动作能力')
            if current and not current.get('released'):
                if current['employee'] != a.employee or current['agent'] != a.agent:
                    raise ValueError('任务已被其他员工领取；过期租约亦需经理核实后释放')
                if current.get('pending'):
                    raise ValueError('存在未完成交接，请重试原动作或交经理恢复，不能重新领取')
                current['expires_at'] = time.time() + 3600
            else:
                for other in leases.values():
                    if not other.get('released') and other['employee'] == a.employee:
                        raise ValueError('该员工已有进行中任务，先交付或阻塞当前任务')
                if 'state:review' not in names(i):
                    for dep in m.get('depends_on', []):
                        d = issue(dep)
                        if d['state'] != 'CLOSED' or 'state:done' not in names(d):
                            raise ValueError(f'依赖 #{dep} 尚未验收完成')
                current = {'employee': a.employee, 'agent': a.agent, 'delivery': uuid.uuid4().hex,
                           'expires_at': time.time() + 3600, 'review': 'state:review' in names(i)}
                leases[key] = current
            save_leases(leases)
            state = 'review' if current['review'] else 'doing'
            m['current_employee'] = a.employee
            patch(a.issue, i, state, role, m)
            print(json.dumps({'claimed': a.issue, 'employee': a.employee, 'delivery': current['delivery'],
                              'review': current['review'], 'body': i['body']}, ensure_ascii=False))
            return
        if not current or current['employee'] != a.employee or current['agent'] != a.agent:
            raise ValueError('先用自己的登记身份 claim')
        if current.get('released'):
            if current.get('completed_action') == a.command:
                print('already completed; no repeated side effects')
                return
            raise ValueError('租约已结束，请重新领取')
        if current.get('pending') and current['pending']['action'] != a.command:
            raise ValueError('先恢复尚未完成的交接动作')
        if not a.body_file:
            raise ValueError('必须提供 --body-file')
        if a.command == 'submit':
            if current['review'] or 'state:doing' not in names(i):
                raise ValueError('只有执行中的任务可以提交')
            m['submitted_by'] = a.employee
            state, target = 'review', m['reviewer_role']
        elif a.command in ('accept', 'return'):
            if not current['review'] or 'state:review' not in names(i) or m.get('submitted_by') == a.employee:
                raise ValueError('必须由独立领取验收的员工操作')
            state, target = ('done', role) if a.command == 'accept' else ('ready', m['executor_role'])
            if a.command == 'accept':
                m['accepted_by'] = a.employee
        elif a.command == 'block':
            if not a.to:
                raise ValueError('block 需要 --to gm/owner')
            state, target = 'blocked', a.to
            m['resume_role'] = role
            m['resume_state'] = 'review' if current['review'] else 'ready'
        else:
            raise ValueError('未知动作')
        m.pop('current_employee', None)
        current['pending'] = {'action': a.command, 'state': state, 'role': target, 'meta': m,
                              'previous_labels': sorted(x for x in names(i) if x.startswith(('role:', 'state:')))}
        save_leases(leases)
        comment(a.issue, a.employee, a.agent, current['delivery'], a.command, a.body_file, i)
        patch(a.issue, i, state, target, m)
        current.update(released=True, completed_action=a.command)
        current.pop('pending', None)
        save_leases(leases)
        print(json.dumps({'issue': a.issue, 'state': state, 'role': target, 'employee': a.employee}))

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['queue', 'claim', 'submit', 'accept', 'return', 'block', 'release'])
    p.add_argument('--role', choices=['gm', 'product', 'engineering', 'ai-content', 'qa', 'cs', 'owner'])
    p.add_argument('--employee')
    p.add_argument('--agent')
    p.add_argument('--issue', type=int)
    p.add_argument('--body-file')
    p.add_argument('--to', choices=['gm', 'owner'])
    a = p.parse_args()
    if a.command == 'queue' and not a.role:
        p.error('queue 需要 --role')
    if a.command != 'queue' and not (a.employee and a.agent and a.issue):
        p.error('操作需要 --employee、--agent 和 --issue')
    try:
        run(a)
    except (RuntimeError, ValueError, KeyError) as e:
        print(f'ERROR: {e}', file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
