import { Icon } from '../ui.tsx';

/** Moduł zaplanowany w kolejnym etapie — pokazujemy uczciwie, że jeszcze nie działa. */
export function PlaceholderPage({ title, icon, stage }: { title: string; icon: string; stage?: { n: number; text: string } }) {
  return (
    <div className="page">
      <div className="page-head">
        <h1>{title}</h1>
      </div>
      <div className="placeholder">
        <Icon name={icon} size={32} />
        {stage ? (
          <>
            <span className="nav-stage big">Etap {stage.n}</span>
            <h2>Moduł w przygotowaniu</h2>
            <p>{stage.text}</p>
            <p className="muted small">Tabele w bazie danych są już przygotowane — moduł zostanie uruchomiony w swoim etapie.</p>
          </>
        ) : (
          <h2>Nie ma takiej strony</h2>
        )}
      </div>
    </div>
  );
}
