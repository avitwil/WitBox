import sys,json,os
bot=sys.argv[1]; n=int(sys.argv[2]) if len(sys.argv)>2 else 1
ms={}
for l in open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','data','bots',bot,'messages.jsonl')):
    m=json.loads(l); ms[m['id']]=m
for m in list(ms.values())[-n:]:
    print(m['role'],m.get('status'),m.get('meta'),m.get('error'))
    for b in m['blocks']:
        print('  ',b['type'],(b.get('name') or b.get('title') or (b.get('text') or ''))[:200].replace('\n',' '), json.dumps(b.get('input'),ensure_ascii=False)[:120] if b.get('input') else '', b.get('status',''))
