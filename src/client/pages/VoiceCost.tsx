import { useEffect, useRef, useState } from 'react';
import type { CostVoiceResult } from '../../shared/types.ts';
import { api, ApiError } from '../api.ts';
import { useApp } from '../state.tsx';
import { Icon, Modal } from '../ui.tsx';

/** Minimalne typy Web Speech API (brak w standardowych typach TypeScript) */
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

function speechCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>;
  return ((w.SpeechRecognition ?? w.webkitSpeechRecognition) as (new () => SpeechRecognitionLike) | undefined) ?? null;
}

const LANGS = [
  { code: 'pl-PL', label: 'PL', example: 'Paliwo dwieście pięćdziesiąt złotych gotówką, auto numer 17' },
  { code: 'uk-UA', label: 'UA', example: 'Паливо двісті пʼятдесят злотих готівкою на авто 17' },
];

const LANG_KEY = 'oa.voice.lang';

export function VoiceCostButton({ onResult, small }: { onResult: (r: CostVoiceResult) => void; small?: boolean }) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  if (!app.meta.voiceEnabled) return null;
  return (
    <>
      <button className={'btn btn-ghost voice-btn' + (small ? ' btn-sm' : '')} onClick={() => setOpen(true)} title="Podyktuj koszt">
        <Icon name="mic" size={small ? 14 : 18} /> Dyktuj
      </button>
      {open && (
        <VoiceCostModal
          onClose={() => setOpen(false)}
          onResult={(r) => {
            setOpen(false);
            onResult(r);
          }}
        />
      )}
    </>
  );
}

function VoiceCostModal({ onClose, onResult }: { onClose: () => void; onResult: (r: CostVoiceResult) => void }) {
  const Ctor = speechCtor();
  const [lang, setLang] = useState(() => {
    try {
      return localStorage.getItem(LANG_KEY) ?? 'pl-PL';
    } catch {
      return 'pl-PL';
    }
  });
  const [text, setText] = useState('');
  const [interim, setInterim] = useState('');
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const rec = useRef<SpeechRecognitionLike | null>(null);
  const base = useRef('');

  useEffect(() => () => rec.current?.stop(), []);

  function chooseLang(code: string) {
    setLang(code);
    try {
      localStorage.setItem(LANG_KEY, code);
    } catch {
      /* tryb prywatny — bez zapamiętania */
    }
  }

  function toggle() {
    setError('');
    if (listening) {
      rec.current?.stop();
      return;
    }
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = lang;
    r.interimResults = true;
    r.continuous = false;
    base.current = text ? text.trimEnd() + ' ' : '';
    r.onresult = (e) => {
      let fin = '';
      let tmp = '';
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) fin += res[0].transcript;
        else tmp += res[0].transcript;
      }
      setText((base.current + fin).trimStart());
      setInterim(tmp);
    };
    r.onerror = (e) => {
      setError(
        e.error === 'not-allowed' || e.error === 'service-not-allowed'
          ? 'Brak dostępu do mikrofonu. Zezwól na mikrofon w ustawieniach przeglądarki albo użyj mikrofonu na klawiaturze.'
          : e.error === 'no-speech'
            ? 'Nic nie usłyszano — spróbuj jeszcze raz.'
            : 'Rozpoznawanie mowy nie zadziałało — użyj mikrofonu na klawiaturze albo wpisz tekst.',
      );
    };
    r.onend = () => {
      setListening(false);
      setInterim('');
    };
    rec.current = r;
    try {
      r.start();
      setListening(true);
    } catch {
      setError('Nie udało się uruchomić mikrofonu.');
    }
  }

  async function recognize() {
    rec.current?.stop();
    setBusy(true);
    setError('');
    try {
      onResult(await api.post<CostVoiceResult>('/api/costs/parse', { text: (text + ' ' + interim).trim() }));
    } catch (err) {
      const ae = err as ApiError;
      setError(ae.fields?.text ?? ae.message);
    } finally {
      setBusy(false);
    }
  }

  const example = LANGS.find((l) => l.code === lang)?.example ?? LANGS[0].example;
  return (
    <Modal title="Podyktuj koszt" onClose={onClose}>
      <div className="form voice-modal">
        <div className="voice-top">
          <div className="seg" role="group" aria-label="Język dyktowania">
            {LANGS.map((l) => (
              <button type="button" key={l.code} className={lang === l.code ? 'on' : ''} onClick={() => chooseLang(l.code)} disabled={listening}>
                {l.label}
              </button>
            ))}
          </div>
          <span className="muted small">Powiedz: kwotę, na co, jak zapłacono i które auto.</span>
        </div>

        {Ctor ? (
          <button type="button" className={'mic-big' + (listening ? ' on' : '')} onClick={toggle} aria-pressed={listening}>
            <Icon name="mic" size={30} />
            <span>{listening ? 'Słucham… (dotknij, aby zakończyć)' : 'Dotknij i mów'}</span>
          </button>
        ) : (
          <p className="hint-box small">
            Ta przeglądarka nie obsługuje dyktowania na stronie. Dotknij pola poniżej i użyj <strong>mikrofonu na klawiaturze</strong>
            telefonu.
          </p>
        )}

        <label className="field">
          <span className="field-label">Tekst kosztu</span>
          <textarea
            rows={3}
            value={listening && interim ? (text + ' ' + interim).trim() : text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`np. „${example}”`}
            maxLength={600}
            readOnly={listening}
          />
        </label>

        {error && (
          <div className="error-box" role="alert">
            <Icon name="alert" />
            <span>{error}</span>
          </div>
        )}
        <p className="muted small">
          Tekst trafia do usługi Claude (Anthropic) tylko w celu rozpoznania pól. Nic nie zostanie zapisane, dopóki nie sprawdzisz
          formularza i nie naciśniesz „Dodaj koszt”.
        </p>
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Anuluj
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || (text + interim).trim().length < 3} onClick={() => void recognize()}>
            {busy ? 'Rozpoznawanie…' : 'Rozpoznaj'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
