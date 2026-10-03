import json, subprocess, time, statistics, pathlib, sys
root=pathlib.Path(sys.argv[1])
swyp=root/'swyp.exe'; src=root/'sum.swyp'; cache=root/'cache'
p=subprocess.Popen([str(swyp),'core-server'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,bufsize=1)
def req(i,out):
    msg={'id':str(i),'action':'build','args':['-entry','sum_to','-profile','fast','-cache-dir',str(cache),'-o',str(out),str(src)]}
    t=time.perf_counter(); p.stdin.write(json.dumps(msg)+'\n'); p.stdin.flush(); line=p.stdout.readline(); dt=(time.perf_counter()-t)*1000
    r=json.loads(line)
    if r['status']!='ok': raise RuntimeError(r)
    return dt,r
cold,_=req('cold',root/'cold.exe')
samples=[]
for i in range(20):
    dt,_=req(i,root/f'hit-{i}.exe'); samples.append(dt)
p.stdin.write(json.dumps({'id':'bye','action':'shutdown'})+'\n'); p.stdin.flush(); p.stdout.readline(); p.wait(timeout=5)
print('COLD_MS=%.3f'%cold)
print('HIT_MEDIAN_MS=%.3f'%statistics.median(samples))
print('HIT_MIN_MS=%.3f'%min(samples))
print('HIT_MAX_MS=%.3f'%max(samples))
print('SPEEDUP_VS_33MS_X=%.2f'%(33.28/statistics.median(samples)))
print('SAMPLES='+','.join('%.2f'%x for x in samples))
