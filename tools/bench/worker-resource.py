"""One fresh worker process: OS CPU and peak-RSS counters, plus index-stage timings.
Linux/macOS resource counters include waited-for descendants; RSS is a high-water
mark, not simultaneous process-tree memory. Unsupported platforms must fail.
"""
import json, os, resource, struct, subprocess, sys, tempfile, time
worker, root, mode = sys.argv[1:4]
with tempfile.TemporaryDirectory(prefix='cie-worker-profile-') as scratch:
    env = dict(os.environ, CIE_EVIDENCE_CORE_MODE=mode,
               CIE_EVIDENCE_CORE_STRICT='1', CIE_WORKER_TIMING=os.path.join(scratch,'stages'))
    params = {'repoPath':root}
    if len(sys.argv)>4:
        with open(sys.argv[4]) as stream:
            params.update(json.load(stream))
    payload = json.dumps({'id':1,'op':'index','params':params}).encode()
    at = time.perf_counter()
    process = subprocess.run([worker],input=struct.pack('>I',len(payload))+payload,
                             stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=120,check=True)
    wall_ms = (time.perf_counter()-at)*1000
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    raw = process.stdout
    if len(raw)<4 or len(raw)!=4+struct.unpack('>I',raw[:4])[0]:
        raise RuntimeError('invalid worker response frame')
    response = json.loads(raw[4:])
    stages = {}
    with open(env['CIE_WORKER_TIMING']) as stream:
        for line in stream:
            label,value = line.rsplit(': ',1)
            stages[label.strip()] = float(value.removesuffix(' ms\n'))
    rss_bytes = usage.ru_maxrss * (1 if sys.platform=='darwin' else 1024)
    print(json.dumps({'response':response,'workerWallMs':wall_ms,
                      'userCpuMs':usage.ru_utime*1000,'systemCpuMs':usage.ru_stime*1000,
                      'peakRssBytes':rss_bytes,'stagesMs':stages}))
