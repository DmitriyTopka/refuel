# dev/rec.py: runs one shell command and records its output lines with real timestamps (asciicast v2).
# usage: python3 -I dev/rec.py out/name.cast "node refuel.mjs check"
import json, shlex, subprocess, sys, time
out, cmd = sys.argv[1], sys.argv[2]
t0 = time.time()
ev = [[0.0, 'o', f'$ {cmd}\r\n']]
p = subprocess.Popen(shlex.split(cmd), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
for line in p.stdout:
    if line.startswith('-> POST'):
        continue  # progress noise from stderr
    ev.append([round(time.time() - t0, 3), 'o', line.rstrip('\n') + '\r\n'])
    sys.stdout.write(line)
p.wait()
with open(out, 'w') as f:
    f.write(json.dumps({'version': 2, 'width': 110, 'height': 30, 'timestamp': int(t0)}) + '\n')
    for e in ev:
        f.write(json.dumps(e) + '\n')
