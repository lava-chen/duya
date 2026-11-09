import io

p = 'packages/command-catalog/src/index.ts'
lines = io.open(p, encoding='utf-8', newline='').read().split('\r\n')

EM = u'—'


def find(pred, start=0):
    for i in range(start, len(lines)):
        if pred(lines[i]):
            return i
    raise AssertionError('not found')


# 1. drop the duplicated BusyDisposition type (commandBusyAction already says it)
i = find(lambda l: l.startswith('export type BusyDisposition'))
assert lines[i - 8] == '/**' and lines[i - 1] == ' */' and lines[i + 1] == ''
del lines[i - 8:i + 2]
print('dropped BusyDisposition')

# 2. drop the duplicated commandBusyDisposition helper
i = find(lambda l: l.startswith('export function commandBusyDisposition'))
j = i
while lines[j - 1] != '/**':
    j -= 1
end = find(lambda l: l == '}', i)
assert lines[end + 1] == '' and lines[end + 2] == ''
del lines[j:end + 3]
print('dropped commandBusyDisposition')

# 3. init: refuse-while-busy becomes defer-while-busy
i = find(lambda l: 'It writes a file into the user' in l)
assert lines[i + 1] == '    // the middle of a running turn.'
assert lines[i + 2] == '    availableWhileBusy: false,'
lines[i:i + 3] = [
    u"    // It writes a file into the user's repository, so it must not land in",
    u'    // the middle of a running turn ' + EM + u' but right after the turn ends is',
    u'    // exactly when the repository is quiet.',
    u'    deferWhileBusy: true,',
]
print('init -> defer')

# 4. the commands that stay refused keep their wording, now owned by the catalog
reasons = [
    ('archive', u'Cannot archive while a turn is running ' + EM + u' press Esc first.'),
    ('delete', u'Cannot delete while a turn is running ' + EM + u' press Esc first.'),
    ('project', u'Cannot switch project while a turn is running ' + EM + u' press Esc first.'),
    ('worktree', u'Finish the current turn before switching its checkout.'),
]
for name, reason in reasons:
    i = find(lambda l, n=name: l.strip() == u"name: '%s'," % n)
    j = find(lambda l: l.strip().startswith('surfaces:'), i)
    lines.insert(j + 1, u"    unavailableReason: '%s'," % reason)
    print('reason ->', name)

io.open(p, 'w', encoding='utf-8', newline='').write('\r\n'.join(lines))
print('written')
