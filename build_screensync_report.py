from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from pathlib import Path
import re

root=Path.cwd(); source=root/'ScreenSync_Report_Content.md'; output=root/'ScreenSync_Project_Report.docx'
NAVY='17324D'; TEAL='147D83'; PALE='EAF2F5'; LIGHT='F4F7F9'; TEXT='1E2933'; MID='557080'
doc=Document(); sec=doc.sections[0]
sec.top_margin=Inches(.72); sec.bottom_margin=Inches(.70); sec.left_margin=Inches(.78); sec.right_margin=Inches(.78); sec.header_distance=Inches(.32); sec.footer_distance=Inches(.32)
styles=doc.styles
normal=styles['Normal']; normal.font.name='Aptos'; normal.font.size=Pt(9.6); normal.font.color.rgb=RGBColor.from_string(TEXT); normal.paragraph_format.space_after=Pt(5); normal.paragraph_format.line_spacing=1.08
for name,size,color in [('Title',26,NAVY),('Subtitle',13,MID),('Heading 1',17,NAVY),('Heading 2',12,TEAL),('Heading 3',10.5,NAVY)]:
 s=styles[name]; s.font.name='Aptos Display' if name in ('Title','Heading 1','Heading 2') else 'Aptos'; s.font.size=Pt(size); s.font.bold=name!='Subtitle'; s.font.color.rgb=RGBColor.from_string(color)
 if name.startswith('Heading'): s.paragraph_format.keep_with_next=True; s.paragraph_format.space_before=Pt(13 if name=='Heading 1' else 8); s.paragraph_format.space_after=Pt(4)
if 'Small Note' not in styles:
 s=styles.add_style('Small Note',1); s.font.name='Aptos'; s.font.size=Pt(8); s.font.italic=True; s.font.color.rgb=RGBColor.from_string(MID)
if 'Code Block' not in styles:
 s=styles.add_style('Code Block',1); s.font.name='Consolas'; s.font.size=Pt(8); s.font.color.rgb=RGBColor.from_string(NAVY); s.paragraph_format.left_indent=Inches(.16); s.paragraph_format.space_after=Pt(2)
header=sec.header.paragraphs[0]; header.alignment=WD_ALIGN_PARAGRAPH.RIGHT
r=header.add_run('SCREENSYNC  /  PROJECT REPORT'); r.font.name='Aptos'; r.font.size=Pt(8); r.font.bold=True; r.font.color.rgb=RGBColor.from_string(TEAL)
footer=sec.footer.paragraphs[0]; footer.alignment=WD_ALIGN_PARAGRAPH.CENTER
r=footer.add_run('Technical report  |  13 November 2026  |  Page '); r.font.name='Aptos'; r.font.size=Pt(8); r.font.color.rgb=RGBColor.from_string(MID)
f=OxmlElement('w:fldSimple'); f.set(qn('w:instr'),'PAGE'); footer._p.append(f)

def shade(cell,fill):
 pr=cell._tc.get_or_add_tcPr(); el=pr.find(qn('w:shd'))
 if el is None: el=OxmlElement('w:shd'); pr.append(el)
 el.set(qn('w:fill'),fill)
def inline(p,text):
 parts=re.split(r'(\*\*.*?\*\*|`.*?`|\[[^\]]+\]\(https?://[^)]+\))',text)
 for part in parts:
  if not part: continue
  if part.startswith('**') and part.endswith('**'): p.add_run(part[2:-2]).bold=True
  elif part.startswith('`') and part.endswith('`'):
   rr=p.add_run(part[1:-1]); rr.font.name='Consolas'; rr.font.size=Pt(8.5); rr.font.color.rgb=RGBColor.from_string(TEAL)
  elif part.startswith('[') and '](' in part and part.endswith(')'):
   label,url=part[1:-1].split('](',1); rid=p.part.relate_to(url,RT.HYPERLINK,is_external=True)
   link=OxmlElement('w:hyperlink'); link.set(qn('r:id'),rid); rr=OxmlElement('w:r'); props=OxmlElement('w:rPr'); color=OxmlElement('w:color'); color.set(qn('w:val'),TEAL); props.append(color); rr.append(props); tx=OxmlElement('w:t'); tx.text=label; rr.append(tx); link.append(rr); p._p.append(link)
  else: p.add_run(part)
def add_table(rows):
 if len(rows)<2: return
 t=doc.add_table(rows=1,cols=len(rows[0])); t.alignment=WD_TABLE_ALIGNMENT.CENTER; t.style='Table Grid'; t.autofit=True
 for i,val in enumerate(rows[0]):
  c=t.rows[0].cells[i]; c.text=''; p=c.paragraphs[0]; p.paragraph_format.space_after=Pt(1); rr=p.add_run(val.strip()); rr.bold=True; rr.font.name='Aptos'; rr.font.size=Pt(8); rr.font.color.rgb=RGBColor(255,255,255); shade(c,NAVY); c.vertical_alignment=WD_CELL_VERTICAL_ALIGNMENT.CENTER
 hdr=OxmlElement('w:tblHeader'); hdr.set(qn('w:val'),'true'); t.rows[0]._tr.get_or_add_trPr().append(hdr)
 for ri,row in enumerate(rows[1:]):
  cells=t.add_row().cells
  for i,val in enumerate(row):
   c=cells[i]; c.text=''; p=c.paragraphs[0]; p.paragraph_format.space_after=Pt(1); inline(p,val.strip());
   for rr in p.runs: rr.font.name='Aptos'; rr.font.size=Pt(7.8); rr.font.color.rgb=RGBColor.from_string(TEXT)
   if ri%2: shade(c,LIGHT)
   c.vertical_alignment=WD_CELL_VERTICAL_ALIGNMENT.CENTER
 for row in t.rows: row._tr.get_or_add_trPr().append(OxmlElement('w:cantSplit'))
 doc.add_paragraph().paragraph_format.space_after=Pt(0)

def md_cells(line): return [x.strip() for x in line.strip().strip('|').split('|')]
lines=source.read_text(encoding='utf-8-sig').splitlines(); i=0; code=False; codebuf=[]; cover=False; first_title=True
while i<len(lines):
 line=lines[i].rstrip(); i+=1
 if line.strip() in ('<!-- COVER END -->','<!-- CONTENTS END -->'): doc.add_page_break(); cover=True; continue
 if line.strip().startswith('```'):
  if not code: code=True; codebuf=[]
  else:
   if codebuf:
    p=doc.add_paragraph(style='Code Block'); p.paragraph_format.keep_together=True; p.add_run('\n'.join(codebuf))
   code=False
  continue
 if code: codebuf.append(line); continue
 if not line.strip(): continue
 if line.startswith('|'):
  block=[md_cells(line)]
  while i<len(lines) and lines[i].strip().startswith('|'): block.append(md_cells(lines[i])); i+=1
  block=[row for row in block if not all(re.fullmatch(r':?-{3,}:?',x.replace(' ','')) for x in row)]
  add_table(block); continue
 if line.startswith('# '):
  p=doc.add_paragraph(style='Title'); inline(p,line[2:].strip()); first_title=False; continue
 if line.startswith('## '): doc.add_heading(line[3:].strip(),level=1); continue
 if line.startswith('### '): doc.add_heading(line[4:].strip(),level=2); continue
 if line.startswith('#### '): doc.add_heading(line[5:].strip(),level=3); continue
 if line.startswith('- '):
  p=doc.add_paragraph(style='List Bullet'); p.paragraph_format.space_after=Pt(2); inline(p,line[2:]); continue
 if re.match(r'^\d+\.\s+',line):
  p=doc.add_paragraph(); p.paragraph_format.left_indent=Inches(.08); p.paragraph_format.space_after=Pt(2); inline(p,line); continue
 if line.startswith('> '):
  p=doc.add_paragraph(style='Small Note'); inline(p,line[2:]); continue
 if not cover and line.startswith('Technical Project Report'):
  p=doc.add_paragraph(style='Subtitle'); inline(p,line); continue
 if not cover and line.startswith('Prepared 13 November'):
  p=doc.add_paragraph(); p.paragraph_format.space_after=Pt(18); inline(p,line)
  for rr in p.runs: rr.font.size=Pt(9); rr.font.color.rgb=RGBColor.from_string(MID)
  continue
 p=doc.add_paragraph(); inline(p,line)
# Cover typography adjustments
if doc.paragraphs:
 title_style=styles['Title']
 if title_style._element.pPr is not None:
  border=title_style._element.pPr.find(qn('w:pBdr'))
  if border is not None: title_style._element.pPr.remove(border)
 for p in doc.paragraphs[:4]: p.paragraph_format.keep_together=True
 if len(doc.paragraphs)>1:
  doc.paragraphs[0].paragraph_format.space_before=Pt(65); doc.paragraphs[0].paragraph_format.space_after=Pt(8)
# metadata
props=doc.core_properties; props.title='ScreenSync Digital Signage and Instagram Content Automation'; props.subject='Technical project report'; props.author='ScreenSync Project Team'; props.keywords='digital signage, WebSocket, OCR, Instagram Graph API, event lifecycle'
doc.save(output); print(output)
