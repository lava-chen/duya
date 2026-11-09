import io
import re

p = 'packages/command-catalog/src/index.ts'
src = io.open(p, encoding='utf-8', newline='').read()
body = src.split('export const COMMAND_SPECS: readonly CommandSpec[] = [', 1)[1]
# split into spec objects by top-level "  {\n"
chunks = re.split(r'\n  \{\n', body)
for chunk in chunks:
    if 'name:' not in chunk:
        continue
    name = re.search(r"name: '([^']+)'", chunk).group(1)
    surfaces = re.search(r"surfaces: \[([^\]]*)\]", chunk)
    surf = surfaces.group(1).replace("'", '').replace(' ', '') if surfaces else '?'
    awb = 'availableWhileBusy: true' in chunk
    awbf = 'availableWhileBusy: false' in chunk
    dwb = 'deferWhileBusy: true' in chunk
    req = 'requiresSession: true' in chunk
    flags = []
    if awb: flags.append('RUN')
    if awbf: flags.append('run=false')
    if dwb: flags.append('DEFER')
    if req: flags.append('needsSession')
    if not awb and not awbf and not dwb: flags.append('-none-')
    print('%-14s %-16s %s' % (name, surf, ' '.join(flags)))
