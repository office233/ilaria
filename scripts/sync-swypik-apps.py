"""Refresh the desktop catalog from Swypik's navigation registry (no secrets read).
Usage: python scripts/sync-swypik-apps.py E:/Swypik/swypik/app
"""
import json
import re
import sys
from pathlib import Path

source = Path(sys.argv[1]) / 'lib/nav/modules.ts'
registry = source.read_text(encoding='utf-8').split('export const NAV_MODULES:')[1].split('export type BottomNavKey')[0]
names = {'shop':'Shop', 'live':'Live', 'go':'Go', 'food':'Food', 'stays':'Stays', 'fly':'Fly', 'movies':'Movies', 'music':'Music', 'gaming':'Gaming', 'news':'News', 'messages':'Messenger', 'missions':'Missions', 'seller':'Seller', 'creator':'Creator', 'liveStudio':'Live Studio', 'host':'Host', 'courier':'Courier', 'fleet':'Fleet', 'admin':'Admin', 'account':'Account', 'myStays':'My Stays', 'help':'Help', 'notifications':'Notifications', 'categories':'Categories', 'orders':'Orders', 'cart':'Cart', 'collections':'Collections'}
apps = [{'id':'home', 'name':'Swypik', 'route':'/', 'group':'community', 'icon':'Home'}, {'id':'discover', 'name':'Discover', 'route':'/discover', 'group':'shopping', 'icon':'Compass'}, {'id':'reels', 'name':'Create', 'route':'/reels/record', 'group':'community', 'icon':'Video'}]
for block in re.split(r'(?=\{\s*id:)', registry)[1:]:
    def field(key):
        match = re.search(r'\b'+key+r':\s*"([^"]+)"', block)
        return match.group(1) if match else ''
    app_id = field('id')
    if not app_id or not field('route'):
        raise ValueError('Unrecognized navigation entry')
    icon = re.search(r'\bicon:\s*(\w+)', block)
    app = {'id':app_id, 'name':names.get(app_id,app_id), 'route':field('route'), 'group':field('group'), 'icon':icon.group(1) if icon else 'LayoutGrid'}
    if field('flag'):
        app['feature'] = field('flag')
    roles = re.search(r'roles:\s*\[([^\]]+)\]', block)
    if roles:
        app['roles'] = re.findall(r'"([^"]+)"', roles.group(1))
    apps.append(app)
assert len({a['id'] for a in apps}) == len(apps)
target = Path(__file__).resolve().parents[1] / 'ui/web/apps.json'
target.write_text(json.dumps(apps, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(f'{len(apps)} applications synchronized to {target}')
