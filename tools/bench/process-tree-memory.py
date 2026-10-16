"""Linux sampled aggregate RSS for concurrent fresh process trees, with a kill budget.
RSS sums count shared pages repeatedly and polling can miss short peaks. This is
an acceptance workload guard, not an application-wide memory/concurrency quota.
"""
import argparse, json, os, signal, subprocess, tempfile, time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--jobs', type=int, default=2)
parser.add_argument('--budget-mib', type=int, default=1536)
parser.add_argument('command', nargs=argparse.REMAINDER)
args = parser.parse_args()
command = args.command[1:] if args.command[:1] == ['--'] else args.command
if not command or not 1 <= args.jobs <= 4 or args.budget_mib <= 0:
    parser.error('supply a command, 1..4 jobs, and a positive memory budget')

def rss_of_trees(roots):
    processes = {};resolved=set();namespace=os.readlink('/proc/self/ns/pid')
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit(): continue
        try:
            fields = (entry/'stat').read_text().rsplit(')',1)[1].split()
            rss = int((entry/'statm').read_text().split()[1])*os.sysconf('SC_PAGE_SIZE')
            processes[int(entry.name)] = (int(fields[1]),rss)
            # /proc can be mounted from an outer PID namespace. Popen.pid is
            # local, while stat's parent IDs and directory names are outer IDs.
            status=(entry/'status').read_text()
            ids=next((line.split()[1:] for line in status.splitlines() if line.startswith('NSpid:')),[])
            if ids and int(ids[-1]) in roots and os.readlink(entry/'ns/pid')==namespace:
                resolved.add(int(entry.name))
        except (OSError,ValueError,IndexError): pass
    selected = resolved
    for _ in range(len(processes)):
        new = {pid for pid,(parent,_) in processes.items() if parent in selected}
        if new <= selected: break
        selected |= new
    return sum(processes.get(pid,(0,0))[1] for pid in selected)

with tempfile.TemporaryDirectory(prefix='cie-concurrent-memory-') as scratch:
    children=[];files=[];peak=0;samples=0;at=time.monotonic();reason=None
    try:
        for job in range(args.jobs):
            stdout=open(Path(scratch)/f'{job}.json','wb');stderr=open(Path(scratch)/f'{job}.log','wb')
            files.append((stdout,stderr))
            children.append(subprocess.Popen(command,stdout=stdout,stderr=stderr,start_new_session=True))
        while any(child.poll() is None for child in children):
            peak=max(peak,rss_of_trees([p.pid for p in children]));samples+=1
            if peak>args.budget_mib*1024*1024: reason='memory budget exceeded';break
            if time.monotonic()-at>180: reason='deadline exceeded';break
            time.sleep(.02)
        if reason: raise RuntimeError(reason)
        if not peak: raise RuntimeError('process-tree RSS was not observable; no memory result is valid')
        results=[]
        for job,child in enumerate(children):
            if child.wait()!=0: raise RuntimeError(f'child {job} failed with exit {child.returncode}')
            path=Path(scratch)/f'{job}.json'
            if path.stat().st_size>1024*1024: raise RuntimeError('unexpected child output size')
            results.append(json.loads(path.read_text()))
        if len({r['metadataHash'] for r in results})!=1: raise RuntimeError('concurrent metadata mismatch')
        print(json.dumps(dict(schema='cie.concurrent-memory.v1',jobs=args.jobs,
            sampledPeakAggregateRssBytes=peak,budgetBytes=args.budget_mib*1024*1024,
            samples=samples,sampleIntervalMs=20,elapsedMs=(time.monotonic()-at)*1000,
            metadataParity=True,results=results),indent=2))
    finally:
        for child in children:
            # Reap whole groups even if a parent exited before a descendant.
            try: os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError: pass
            child.wait()
        for stdout,stderr in files: stdout.close();stderr.close()
