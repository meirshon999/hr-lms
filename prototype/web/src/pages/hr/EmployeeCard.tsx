import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, patch, post, ApiError } from '../../api';
import { useAsync, useBump, Loader, ErrorBox, fmtDate, STAGE_LABEL, useToast } from '../../lib';

interface Card {
  id: string; full_name: string; phone: string; start_date: string; position: string;
  login: string | null;
  stage: string; internship_passed: boolean;
  pre_onboarding: { done: boolean; viewed: number; total: number };
  onboarding_opened_at: string | null; onboarding_due_date: string | null; overdue: boolean;
  completed_at: string | null; archived_at: string | null; trajectory_status: string | null;
  paused_at: string | null;
  blocks: { id: string; title: string; lessons: {
    id: string; title: string; status: string; material_done: boolean; test_attempts: number; passed_at: string | null;
  }[] }[];
  attestation: { attempts: { attempt_no: number; score_pct: number; passed: boolean }[] };
}

export function EmployeeCard() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { bump } = useBump();
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => get<Card>(`/employees/${id}`), [id]);
  const [modal, setModal] = useState<null | { title: string; body: React.ReactNode }>(null);
  const [editing, setEditing] = useState(false);

  async function act(path: string, ok: string, body?: unknown) {
    try {
      const r = await post<any>(`/employees/${id}/${path}`, body);
      if (r.deleted) { toast('Сотрудник удалён'); nav('/hr/employees'); bump(); return; }
      if (path === 'internship-passed' && !r.onboarding_opened)
        toast('Стажировка отмечена. Онбординг откроется после завершения пре-онбординга.', 'warn');
      else toast(ok);
      bump(); reload();
    } catch { toast('Не удалось выполнить', 'warn'); }
  }

  /** Всё, что нужно передать сотруднику, — одним экраном: адрес, логин, пароль. */
  async function showAccess() {
    const inv = await post<{ invite_url: string; login: string }>(`/employees/${id}/invite`);
    const render = (pw?: string) => ({
      title: 'Доступ сотрудника',
      body: (
        <div className="stack" style={{ fontSize: 14 }}>
          <p className="muted" style={{ fontSize: 13 }}>Передайте сотруднику эти три строки.</p>
          <div className="banner info"><b>Адрес:</b> {inv.invite_url}</div>
          <div className="banner info"><b>Логин:</b>{' '}
            <span style={{ fontFamily: 'monospace' }}>{inv.login}</span></div>
          {pw
            ? <div className="banner ok"><b>Пароль:</b>{' '}
                <span style={{ fontFamily: 'monospace', fontSize: 16 }}>{pw}</span>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  Скопируйте — больше он не покажется.
                </div>
              </div>
            : <button className="btn sm" onClick={async () => {
                if (!confirm('Задать сотруднику новый пароль? Старый перестанет работать.')) return;
                const r = await post<{ password: string }>(`/employees/${id}/reset-password`);
                setModal(render(r.password));
              }}>Сбросить пароль</button>}
        </div>
      ),
    });
    setModal(render());
  }


  if (loading) return <Loader />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;

  return (
    <>
      <button className="btn ghost sm" onClick={() => nav('/hr/employees')}>← К списку</button>
      <h1 className="mt16">{data.full_name}</h1>
      <p className="subtitle">
        {data.position} · <span className={`pill stage-${data.stage}`}>{STAGE_LABEL[data.stage]}</span>
        {data.overdue && <> · <span className="pill overdue">Просрочено</span></>}
        {data.paused_at && <> · <span className="pill">На паузе с {fmtDate(data.paused_at)}</span></>}
      </p>

      <div className="panel">
        <div className="row-between" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Профиль и доступ</h3>
          {!editing && <button className="btn ghost sm" onClick={() => setEditing(true)}>Изменить</button>}
        </div>
        {editing
          ? <EditProfile data={data} onDone={() => { setEditing(false); reload(); bump(); }} onCancel={() => setEditing(false)} />
          : (
            <dl className="kv">
              <dt>Телефон</dt><dd>{data.phone}</dd>
              <dt>Логин</dt>
              <dd style={{ fontFamily: 'monospace' }}>
                {data.login}
                {data.stage !== 'archived' && (
                  <button className="btn ghost sm" style={{ padding: '2px 10px', marginLeft: 8 }}
                    onClick={() => showAccess()}>Доступ сотрудника</button>
                )}
              </dd>
              <dt>Дата выхода</dt><dd>{fmtDate(data.start_date)}</dd>
              <dt>Пре-онбординг</dt><dd>{data.pre_onboarding.viewed} из {data.pre_onboarding.total} {data.pre_onboarding.done && '· пройден ✓'}</dd>
              {data.onboarding_opened_at && <><dt>Онбординг открыт</dt><dd>{fmtDate(data.onboarding_opened_at)}</dd></>}
              {data.onboarding_due_date && <><dt>Срок</dt>
                <dd>{fmtDate(data.onboarding_due_date)}{data.paused_at && <span className="muted"> — заморожен</span>}</dd></>}
              {data.completed_at && <><dt>Завершил</dt><dd>{fmtDate(data.completed_at)}</dd></>}
            </dl>
          )}
      </div>

      {modal && (
        <div className="modal-bg" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{modal.title}</h3>
            {modal.body}
            <div className="row"><button className="btn sm" onClick={() => setModal(null)}>Закрыть</button></div>
          </div>
        </div>
      )}

      {/* --- действия --- */}
      {data.stage === 'intern' && (
        <div className="panel">
          <h3>Стажировка</h3>
          <p className="muted" style={{ fontSize: 14, marginBottom: 12 }}>
            Когда наставник подтвердит стажировку — откройте онбординг. Пре-онбординг должен быть пройден.
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn sm" onClick={() => act('internship-passed', 'Онбординг открыт')}>
              Стажировка пройдена
            </button>
            <button className="btn danger sm" onClick={() => {
              if (confirm(`Удалить сотрудника «${data.full_name}»? Аккаунт и весь прогресс будут удалены безвозвратно.`))
                act('internship-failed', '');
            }}>Не прошёл</button>
          </div>
        </div>
      )}

      {data.stage !== 'archived' && data.stage !== 'intern' && (
        <div className="panel">
          <h3>Онбординг</h3>
          {data.blocks.map((b) => (
            <div key={b.id} style={{ marginBottom: 14 }}>
              <div className="block-h" style={{ marginTop: 4 }}>{b.title}</div>
              {b.lessons.map((l) => (
                <div key={l.id} className="lesson-row" style={{ padding: '9px 4px' }}>
                  <div className={`ico ${l.status === 'passed' ? '' : ''}`}
                    style={{ background: l.status === 'passed' ? '#e4f1ea' : '#f0ebe4', color: l.status === 'passed' ? 'var(--success)' : 'var(--muted)' }}>
                    {l.status === 'passed' ? '✓' : l.status === 'available' ? '•' : '🔒'}
                  </div>
                  <div className="tx"><b>{l.title}</b></div>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {l.material_done ? 'материал ✓' : 'материал —'} · попыток теста: {l.test_attempts}
                  </span>
                </div>
              ))}
            </div>
          ))}
          {data.stage === 'onboarding' && (
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', margin: '4px 0 14px' }}>
              {data.paused_at ? (
                <button className="btn sm" onClick={() => act('resume', 'Онбординг возобновлён')}>
                  Снять с паузы
                </button>
              ) : (
                <button className="btn ghost sm" onClick={() => {
                  if (confirm('Поставить онбординг на паузу? Пока стоит пауза, срок не идёт.'))
                    act('pause', 'Онбординг на паузе');
                }}>На паузу</button>
              )}
              <button className="btn ghost sm" onClick={() => {
                const v = prompt('На сколько дней продлить срок?', '7');
                const days = Number(v);
                if (!v || !Number.isInteger(days) || days < 1 || days > 90)
                  return v === null ? undefined : toast('Нужно целое число от 1 до 90', 'warn');
                act('extend-deadline', `Срок продлён на ${days} дн.`, { days });
              }}>Продлить срок</button>
            </div>
          )}

          <div className="block-h">Аттестация</div>
          {data.attestation.attempts.length === 0
            ? <p className="muted" style={{ fontSize: 13 }}>Попыток пока нет</p>
            : data.attestation.attempts.map((a) => (
              <div key={a.attempt_no} style={{ fontSize: 13 }}>
                Попытка {a.attempt_no}: {a.score_pct}% — {a.passed ? 'сдана' : 'не сдана'}
              </div>
            ))}
        </div>
      )}

      {data.stage !== 'archived' && (
        <button className="btn danger sm" onClick={() => {
          if (confirm(`Перевести «${data.full_name}» в архив? Вход будет закрыт, данные обучения сохранятся.`))
            act('archive', 'Переведён в архив');
        }}>В архив</button>
      )}
      {data.stage === 'archived' && (
        <div className="stack" style={{ gap: 10 }}>
          <div className="banner info">Сотрудник в архиве с {fmtDate(data.archived_at)}. Вход закрыт.</div>
          <button className="btn sm" onClick={() => {
            if (confirm(`Вернуть «${data.full_name}» из архива? Доступ откроется, прогресс обучения сохранён.`))
              act('unarchive', 'Возвращён из архива');
          }}>Вернуть из архива</button>
        </div>
      )}

      <AuditPanel employeeId={data.id} />
    </>
  );
}

const ACTION_LABEL: Record<string, string> = {
  hire: 'Завёл сотрудника',
  internship_passed: 'Отметил стажировку пройденной',
  archive: 'Перевёл в архив',
  edit_profile: 'Изменил профиль',
  reset_password: 'Сбросил пароль',
};

function AuditPanel({ employeeId }: { employeeId: string }) {
  const { data } = useAsync(
    () => get<{ items: { ts: string; actor_login: string; action: string; detail: string }[] }>(
      `/employees/${employeeId}/audit`), [employeeId]);
  if (!data?.items.length) return null;
  return (
    <div className="panel mt16">
      <h3>История действий</h3>
      {data.items.map((a, i) => (
        <div key={i} style={{ display: 'flex', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--line)', fontSize: 13.5 }}>
          <span className="muted" style={{ flex: 'none', width: 120 }}>
            {new Date(a.ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </span>
          <span style={{ flex: 1 }}>
            <b>{ACTION_LABEL[a.action] ?? a.action}</b>
            {a.detail && <span className="muted"> — {a.detail}</span>}
          </span>
          <span className="muted" style={{ flex: 'none' }}>{a.actor_login}</span>
        </div>
      ))}
    </div>
  );
}

function EditProfile({ data, onDone, onCancel }: { data: Card; onDone: () => void; onCancel: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ full_name: data.full_name, phone: data.phone });
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await patch(`/employees/${data.id}`, f);
      toast('Профиль обновлён');
      onDone();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Не удалось сохранить', 'warn');
    } finally { setBusy(false); }
  }

  return (
    <div style={{ maxWidth: 380 }}>
      <label className="field"><span>ФИО</span>
        <input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></label>
      <label className="field"><span>Телефон</span>
        <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn ghost sm" onClick={onCancel}>Отмена</button>
        <button className="btn sm" disabled={busy} onClick={save}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
      </div>
    </div>
  );
}
