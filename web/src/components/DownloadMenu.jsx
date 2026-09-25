import { useEffect, useRef, useState } from 'react';
import L from '../labels';
import { admin } from '../lib/api';

const D = L.console.dash;

/**
 * The dashboard's two downloads.
 *
 * Excel is a plain link to `report.xlsx` carrying the dashboard's own range
 * parameters — the browser downloads it, so nothing has to be held in memory
 * here and a slow report cannot freeze the page.
 *
 * PDF is the browser's own print dialog against a print stylesheet, rather than
 * a server-rendered document: the charts on screen are then exactly what comes
 * out, and there is no second rendering path to keep in step with this one.
 * Every phone and desktop browser offers "Save as PDF" there.
 */
export default function DownloadMenu({ params }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);

  // Click-away and Escape, so the menu never strands a tap on a phone.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrap.current && !wrap.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrap}>
      <button
        type="button"
        className="btn-ghost !py-1.5 text-sm"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        ⬇ {D.download}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-2 w-[min(20rem,calc(100vw-2rem))] overflow-hidden
                     rounded-2xl border border-slate-200 bg-white shadow-lg"
        >
          <a
            role="menuitem"
            href={admin.reportXlsxUrl(params)}
            download
            onClick={() => setOpen(false)}
            className="block px-4 py-3 text-left hover:bg-slate-50"
          >
            <span className="block font-semibold text-slate-800">{D.downloadExcel}</span>
            <span className="block text-xs text-slate-500">{D.downloadExcelHint}</span>
          </a>
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              // Let the menu close (and repaint) before the dialog blocks the page.
              setTimeout(() => window.print(), 50);
            }}
            className="block w-full border-t border-slate-100 px-4 py-3 text-left hover:bg-slate-50"
          >
            <span className="block font-semibold text-slate-800">{D.downloadPdf}</span>
            <span className="block text-xs text-slate-500">{D.downloadPdfHint}</span>
          </button>
        </div>
      )}
    </div>
  );
}
