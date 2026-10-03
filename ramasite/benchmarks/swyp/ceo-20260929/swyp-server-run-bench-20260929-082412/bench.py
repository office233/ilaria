import json, subprocess, time, statistics, pathlib, sys
root=pathlib.Path(sys.argv[1]); swyp=root/'swyp.exe'; src=root/'sum.swyp'
p=subprocess.Popen([str(swyp),'core-server'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,bufsize=1)
def q(msg):
    t=time.perf_counter(); p.stdin.write(json.dumps(msg)+'\n'); p.stdin.flush(); line=p.stdout.readline(); dt=(time.perf_counter()-t)*1000; r=json.loads(line)
    if r.get('status')!='ok': raise RuntimeError(r)
    return dt,r
# warmup
for i in range(5): q({'id':f'w{i}','action':'run','args':['-profile','fast','-entry','sum_to',str(src),'100']})
runs=[]
for i in range(50): runs.append(q({'id':f'r{i}','action':'run','args':['-profile','fast','-entry','sum_to',str(src),'100']})[0])
checks=[]
for i in range(30): checks.append(q({'id':f'c{i}','action':'check','args':['-entry','sum_to',str(src)]})[0])
p.stdin.write(json.dumps({'id':'bye','action':'shutdown'})+'\n'); p.stdin.flush(); p.stdout.readline(); p.wait(timeout=5)
print('RUN_MEDIAN_MS=%.4f'%statistics.median(runs)); print('RUN_MIN_MS=%.4f'%min(runs)); print('RUN_P95_MS=%.4f'%sorted(runs)[int(len(runs)*.95)-1]); print('CHECK_MEDIAN_MS=%.4f'%statistics.median(checks)); print('CHECK_MIN_MS=%.4f'%min(checks)); print('CHECK_P95_MS=%.4f'%sorted(checks)[int(len(checks)*.95)-1])
