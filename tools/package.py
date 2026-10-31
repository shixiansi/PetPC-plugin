#!/usr/bin/env python3
"""tools/package.py — tools/package.ps1 的 Linux 等价（本机没有 PowerShell）。

对每个 plugins/<id>/manifest.json：
  1. 校验 entry 与固定资源（panel.html / app.js / style.css）存在；
  2. 以固定时间戳重建 dist/<id>-<version>.zip（manifest + 固定资源 + assets，全部在 zip 根）；
  3. 计算 SHA256；
  4. 从打包出的 manifest 重建 index.json（权限与 netHosts 必须来自包内，不允许漂移）。

与 package.ps1 的字节兼容性不追求（压缩器不同），追求的是**内容**一致：
同一批成员、同样的固定时间戳（2024-01-01T00:00:00Z）、根目录无包裹层。
"""
import json
import hashlib
import sys
import io
import zipfile
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PLUGINS = REPO / 'plugins'
DIST = REPO / 'dist'
INDEX = REPO / 'index.json'
FIXED = ['panel.html', 'app.js', 'style.css']
PINNED = (2024, 1, 1, 0, 0, 0)


def json_string(v: str) -> str:
    out = ['"']
    for ch in v:
        if ch == '\\':
            out.append('\\\\')
        elif ch == '"':
            out.append('\\"')
        elif ch == '\r':
            out.append('\\r')
        elif ch == '\n':
            out.append('\\n')
        elif ch == '\t':
            out.append('\\t')
        else:
            out.append(ch)
    out.append('"')
    return ''.join(out)


def main() -> int:
    # 可选参数：只打包这些插件 id（发布单个插件时用）。给了就只碰它们，
    # 其余的 zip 与 index 条目原样不动——一次局部发版不该重写别人的版本号。
    only = set(sys.argv[1:])
    if not PLUGINS.is_dir():
        print(f'插件目录不存在：{PLUGINS}', file=sys.stderr)
        return 2
    DIST.mkdir(parents=True, exist_ok=True)
    entries = []
    for manifest_path in sorted(PLUGINS.glob('*/manifest.json')):
        plugin_dir = manifest_path.parent
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        pid, version, entry = manifest['id'], manifest['version'], manifest['entry']
        if only and pid not in only:
            continue
        missing = [r for r in ([entry, *FIXED]) if not (plugin_dir / r).is_file()]
        if missing:
            raise SystemExit(f'插件 {pid} 缺少资源文件：{missing}')

        members = ['manifest.json']
        for name in [*FIXED, entry]:
            if name not in members:
                members.append(name)
        for asset in manifest.get('assets') or []:
            if not asset or asset.startswith('/') or '..' in Path(asset).parts or Path(asset).parts.count('.'):
                raise SystemExit(f'插件 {pid} 的 assets 不合法：{asset}')
            if asset not in members:
                members.append(asset)
            if not (plugin_dir / asset).is_file():
                raise SystemExit(f'插件 {pid} 声明的 assets 文件不存在：{asset}')

        zip_path = DIST / f'{pid}-{version}.zip'
        # 先在内存里打，再和已发布的同名包比字节。
        #
        # 为什么：2026-11-01 我改了 live-danmaku 的代码、重打包、**忘了升版本**——于是目录里
        # 那一份 1.0.2 的字节变了、版本没变，而已经装了 1.0.2 的人永远不会被提示更新。
        # 那个 bug 只能靠人记得；zip 的 date_time 是钉住的（PINNED），内容一样就是字节一样，
        # 所以"同版本不同内容"可以在这里判出来。
        stamp = datetime(*PINNED, tzinfo=timezone.utc)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
            for member in members:
                info = zipfile.ZipInfo(member, date_time=stamp.timetuple()[:6])
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                zf.writestr(info, (plugin_dir / member).read_bytes())
        data = buffer.getvalue()
        if zip_path.exists() and zip_path.read_bytes() != data:
            raise SystemExit(
                f'插件 {pid} 的版本没变（{version}）但内容变了：'
                f'dist/{zip_path.name} 已经发布过。先升版本再打包——'
                f'否则已经装了 {version} 的人永远收不到这次改动。')
        zip_path.write_bytes(data)
        sha = hashlib.sha256(data).hexdigest()

        entry_obj = {
            'id': pid,
            'name': manifest['name'],
            'version': version,
            'author': manifest['author'],
            'description': manifest['description'],
            'permissions': list(manifest.get('permissions') or []),
            'download': f'dist/{zip_path.name}',
            'sha256': sha,
        }
        # netHosts 只有声明了 net.fetch 才需要；没有就不写字段（与既有 index.json 一致）。
        # 顺序按既有文件来：permissions 之后、download 之前。
        if manifest.get('netHosts'):
            reordered = {}
            for k, v in entry_obj.items():
                reordered[k] = v
                if k == 'permissions':
                    reordered['netHosts'] = list(manifest['netHosts'])
            entry_obj = reordered
        entries.append(entry_obj)
        print(f'打包 {pid} {version} → {zip_path.name} ({sha[:12]}…)')

    entries.sort(key=lambda e: e['id'])
    from datetime import datetime as dt
    if only:
        # 只打包了指定插件：把它们**合并**进现有 index.json，而不是用这几条重写整份。
        # 重写整份的后果是"发布 A 插件顺手把 B 插件的版本号退回文件里的旧值"——那正是
        # 一次局部发版最不该发生的事。
        if not INDEX.is_file():
            print(f'index.json 不存在，无法按 id 合并：{INDEX}', file=sys.stderr)
            return 2
        merged = json.loads(INDEX.read_text(encoding='utf-8'))
        by_id = {e.get('id'): e for e in merged.get('plugins') or []}
        for entry in entries:
            by_id[entry['id']] = entry
        merged['plugins'] = [by_id[k] for k in sorted(by_id)]
        merged['updatedAt'] = dt.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        index = merged
    else:
        index = {
            'version': 1,
            'updatedAt': dt.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
            'plugins': entries,
        }
    # indent=2 但把数组压成一行（Python 没有 json.dumps 的这个开关，手动收）：
    # 与仓库既有 index.json 的排版一致——数组一行、对象多行。
    text = reformat(index) + '\n'
    # newline='' —— 不要跟着平台翻译行尾。`Path.write_text` 在 Windows 上把 \n 写成 \r\n，
    # 于是 index.json 每次打包都变成"整文件 164 行全变"，真正的内容改动（几个版本号）淹没在
    # 里面；仓库里这份是 Linux 上写的（\n），两边轮流发布就会来回翻一次。显式写死 \n。
    with open(INDEX, 'w', encoding='utf-8', newline='') as fh:
        fh.write(text)
    scope = f'（本次只处理 {len(entries)} 个）' if only else ''
    print(f'index.json 已更新{scope}：共 {len(index.get("plugins") or [])} 个插件')
    return 0


def reformat(value, indent=0):
    """数组压一行、对象按行展开的 JSON 排版（与仓库既有 index.json 相同）。"""
    pad = '  ' * indent
    inner = '  ' * (indent + 1)
    if isinstance(value, list):
        if all(not isinstance(x, (dict, list)) for x in value):
            return '[' + ', '.join(json_string(x) if isinstance(x, str) else json.dumps(x) for x in value) + ']'
        items = [inner + reformat(x, indent + 1) for x in value]
        return '[\n' + ',\n'.join(items) + '\n' + pad + ']'
    if isinstance(value, dict):
        items = []
        for k, v in value.items():
            # 最后一个键不带逗号（JSON 排版），写成「键: 值」逐行展开。
            line = inner + json_string(k) + ': ' + reformat(v, indent + 1)
            items.append(line)
        return '{\n' + ',\n'.join(items) + '\n' + pad + '}'
    if isinstance(value, str):
        return json_string(value)
    return json.dumps(value)


if __name__ == '__main__':
    raise SystemExit(main())
