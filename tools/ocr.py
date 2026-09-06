# -*- coding: utf-8 -*-
# 本地 OCR：把图片中的文字识别出来，供任意文本大模型解析
# 依赖：pip install rapidocr-onnxruntime
# 可选环境变量 OCR_LIBS：指定依赖库目录（多个用分号分隔）
import sys, os, json

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

libs = os.environ.get('OCR_LIBS')
if libs:
    for p in libs.split(os.pathsep):
        if p and os.path.isdir(p):
            sys.path.insert(0, p)

def main():
    if len(sys.argv) < 2:
        print(json.dumps({'ok': False, 'error': '缺少图片路径'}, ensure_ascii=False))
        return
    try:
        from rapidocr_onnxruntime import RapidOCR
    except Exception:
        print(json.dumps({'ok': False, 'error': '未安装 OCR 组件，请先运行：pip install rapidocr-onnxruntime'}, ensure_ascii=False))
        return
    try:
        ocr = RapidOCR()
        result, _ = ocr(sys.argv[1])
        lines = [item[1] for item in result] if result else []
        print(json.dumps({'ok': True, 'text': '\n'.join(lines), 'count': len(lines)}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False))

if __name__ == '__main__':
    main()