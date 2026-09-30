#!/usr/bin/env python3
"""Find unbalanced block comments in app.js with a correct tokenizer."""
import sys

path = sys.argv[1] if len(sys.argv) > 1 else 'app.js'
t = open(path).read()
n = len(t)
i = 0
line = 1
stack = []          # lines where /* opened and not yet closed
instr = None        # current string quote char
in_line = False     # inside // comment
in_block = None     # line where current /* opened

def cur_line():
    return line

while i < n:
    c = t[i]
    if c == '\n':
        line += 1
        i += 1
        in_line = False
        continue
    if in_block is not None:
        if t.startswith('*/', i):
            in_block = None
            stack.pop()
            i += 2
        else:
            i += 1
        continue
    if in_line:
        i += 1
        continue
    if instr is not None:
        if c == '\\':
            i += 2
            continue
        if c == instr:
            instr = None
        i += 1
        continue
    if c in "'\"`":
        instr = c
        i += 1
        continue
    if t.startswith('//', i):
        in_line = True
        i += 2
        continue
    if t.startswith('/*', i):
        in_block = line
        stack.append(line)
        i += 2
        continue
    if t.startswith('*/', i):
        if stack:
            stack.pop()
        else:
            print('STRAY */ at line', line)
        i += 2
        continue
    i += 1

if stack:
    print('UNCLOSED /* opened at lines:', stack)
else:
    print('OK: all block comments balanced')
if instr:
    print('UNTERMINATED string quote:', repr(instr))
