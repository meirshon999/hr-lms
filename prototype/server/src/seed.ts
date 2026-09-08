import { db, migrate, one, run, uuid, wipe } from './db.ts';
import { hashPassword } from './auth.ts';
import { stamp, today } from './clock.ts';
import { markLessonPassedIfReady, takePreSnapshot, tryOpenOnboarding } from './domain.ts';
import { clearEvents } from './events.ts';
import { attestationBlockOf, findLesson, preSnapshotOf, snapshotOf } from './snapshot.ts';

interface Q { text: string; options: string[]; correct: number; }
interface LessonDef {
  title: string;
  material: { type: 'video' | 'pdf' | 'text'; text?: string; url?: string; watch?: number };
  questions: Q[];
}
interface BlockDef { title: string; lessons: LessonDef[]; }
interface TrajectoryDef {
  position: string;
  status: 'draft' | 'active';
  pre: Array<{ title: string; type: 'text' | 'video'; text?: string }>;
  blocks: BlockDef[];
  attestation: Q[] | null;
}

function addQuestions(testId: string, qs: Q[]) {
  qs.forEach((q, i) =>
    run('INSERT INTO questions (id, test_id, ord, text, options, correct_index) VALUES (?,?,?,?,?,?)',
      uuid(), testId, i + 1, q.text, JSON.stringify(q.options), q.correct));
}

function buildTrajectory(def: TrajectoryDef): { positionId: string; lessonIds: string[]; attBlockId: string | null } {
  const posId = uuid();
  run('INSERT INTO positions (id, name) VALUES (?, ?)', posId, def.position);
  const trajId = uuid();
  run('INSERT INTO trajectories (id, position_id, status) VALUES (?, ?, ?)', trajId, posId, def.status);

  def.pre.forEach((it, i) =>
    run(`INSERT INTO pre_onboarding_items (id, trajectory_id, ord, title, content_type, file_url, text_body)
         VALUES (?,?,?,?,?,?,?)`,
      uuid(), trajId, i + 1, it.title, it.type,
      it.type === 'video' ? 'demo:welcome' : null,
      it.type === 'text' ? it.text ?? '' : null));

  const lessonIds: string[] = [];
  def.blocks.forEach((b, bi) => {
    const blockId = uuid();
    run('INSERT INTO blocks (id, trajectory_id, ord, title, kind) VALUES (?,?,?,?,?)',
      blockId, trajId, bi + 1, b.title, 'regular');
    b.lessons.forEach((l, li) => {
      const lid = uuid();
      lessonIds.push(lid);
      run('INSERT INTO lessons (id, block_id, ord, title) VALUES (?,?,?,?)', lid, blockId, li + 1, l.title);
      run('INSERT INTO materials (id, lesson_id, content_type, file_url, text_body, min_watch_pct) VALUES (?,?,?,?,?,?)',
        uuid(), lid, l.material.type,
        l.material.type === 'text' ? null : (l.material.url ?? 'demo:file'),
        l.material.type === 'text' ? l.material.text ?? '' : null,
        l.material.type === 'video' ? (l.material.watch ?? 80) : null);
      const testId = uuid();
      run('INSERT INTO tests (id, lesson_id, pass_mark_pct) VALUES (?,?,70)', testId, lid);
      addQuestions(testId, l.questions);
    });
  });

  const attBlockId = uuid();
  run('INSERT INTO blocks (id, trajectory_id, ord, title, kind) VALUES (?,?,?,?,?)',
    attBlockId, trajId, 999, 'Аттестация', 'attestation');
  if (def.attestation) {
    const attTestId = uuid();
    run('INSERT INTO tests (id, block_id, pass_mark_pct) VALUES (?,?,70)', attTestId, attBlockId);
    addQuestions(attTestId, def.attestation);
  }
  return { positionId: posId, lessonIds, attBlockId: def.attestation ? attBlockId : null };
}

// ---- общие тексты пре-онбординга ----
const PRE_COMMON = [
  {
    title: 'О Pingwin Premium', type: 'text' as const,
    text: 'Pingwin Premium — сеть развлечений под одной крышей: рестораны, боулинг и караоке. '
      + 'Мы про сервис, скорость и атмосферу. Для гостя нет «не мой участок» — сотрудник отвечает '
      + 'за впечатление целиком. Наша цель — чтобы гость вернулся и привёл друзей.',
  },
  {
    title: 'Форматы и площадка', type: 'text' as const,
    text: 'Три зоны: зал ресторана, дорожки боулинга, караоке-кабинеты. Гость легко перемещается '
      + 'между ними в течение вечера, поэтому важно ориентироваться на всей площадке: где бар, '
      + 'кухня, туалеты, гардероб, эвакуационные выходы, зона для детей.',
  },
  { title: 'Welcome-видео от управляющего', type: 'video' as const },
];

function seedContent() {
  // ============ ОФИЦИАНТ (опубликована) ============
  const officiant = buildTrajectory({
    position: 'Официант', status: 'active',
    pre: [
      ...PRE_COMMON,
      {
        title: 'Обязанности официанта', type: 'text',
        text: 'Официант встречает и рассаживает гостей, консультирует по меню, принимает и вносит '
          + 'заказы, подаёт блюда и напитки, следит за столом, рассчитывает гостя, поддерживает '
          + 'чистоту зоны. KPI: скорость подачи, средний чек, отсутствие ошибок в заказах, отзывы.',
      },
    ],
    blocks: [
      {
        title: 'Welcome',
        lessons: [
          {
            title: 'Ценности и стандарты сервиса',
            material: {
              type: 'text',
              text: 'Пять стандартов сервиса Pingwin:\n'
                + '1. Встречаем гостя в течение 30 секунд, провожаем к столу.\n'
                + '2. Знаем меню и стоп-лист наизусть.\n'
                + '3. Предлагаем конкретные позиции, а не спрашиваем «что-нибудь ещё?».\n'
                + '4. Замечаем и решаем проблему до того, как гость пожаловался.\n'
                + '5. Прощаемся так, чтобы захотелось вернуться.',
            },
            questions: [
              { text: 'За сколько секунд встречаем гостя?', options: ['30 секунд', '5 минут', 'Когда освободимся'], correct: 0 },
              { text: 'Как предлагаем позиции меню?', options: ['«Что-нибудь ещё?»', 'Конкретные позиции', 'Молча ждём'], correct: 1 },
              { text: 'Когда решаем проблему гостя?', options: ['После жалобы', 'До жалобы', 'Всегда через администратора'], correct: 1 },
            ],
          },
          {
            title: 'Внешний вид и дисциплина',
            material: {
              type: 'text',
              text: 'Форма чистая и выглаженная, бейдж на месте, обувь закрытая, волосы убраны. '
                + 'Личный телефон — только в подсобке. При опоздании предупреждаем администратора '
                + 'заранее. Смена начинается с брифинга: стоп-лист, брони, спецпредложения дня.',
            },
            questions: [
              { text: 'Где пользуемся личным телефоном?', options: ['В зале', 'В подсобке', 'За барной стойкой'], correct: 1 },
              { text: 'При опоздании нужно:', options: ['Ничего', 'Предупредить администратора заранее', 'Прийти и промолчать'], correct: 1 },
              { text: 'С чего начинается смена?', options: ['С брифинга', 'С уборки зала', 'С обеда'], correct: 0 },
            ],
          },
        ],
      },
      {
        title: 'Знакомство с объектом',
        lessons: [
          {
            title: 'Зоны зала, бар и кухня',
            material: {
              type: 'text',
              text: 'Зал разделён на секции — у каждого официанта свои столы. Бар готовит напитки и '
                + 'коктейли, кухня — блюда; окно выдачи и экран заказов у прохода на кухню. '
                + 'Дорожки боулинга и караоке обслуживаются отдельной бригадой, но заказ еды туда '
                + 'принимает официант зоны.',
            },
            questions: [
              { text: 'Кто принимает заказ еды на дорожки боулинга?', options: ['Официант зоны', 'Никто', 'Только бармен'], correct: 0 },
              { text: 'Где отслеживать статус заказа?', options: ['На экране заказов у кухни', 'По памяти', 'Спрашивать повара каждые 5 минут'], correct: 0 },
            ],
          },
          {
            title: 'Безопасность и эвакуация',
            material: {
              type: 'video', url: 'demo:safety', watch: 90,
            },
            questions: [
              { text: 'При запахе гари в зале:', options: ['Сообщить администратору и следовать инструкции', 'Ничего', 'Уйти домой'], correct: 0 },
              { text: 'Эвакуационные выходы должны быть:', options: ['Свободны и не заставлены', 'Закрыты на ключ', 'Заставлены стульями'], correct: 0 },
            ],
          },
        ],
      },
      {
        title: 'Ввод в должность',
        lessons: [
          {
            title: 'Меню и стоп-лист',
            material: {
              type: 'text',
              text: 'Меню: закуски, супы, горячее, гарниры, напитки, десерты. Стоп-лист обновляется '
                + 'каждое утро и перед вечерней сменой — сверяйся до открытия. Не знаешь состав или '
                + 'аллергены блюда — уточни у повара, не выдумывай. Помни топ-3 позиции для '
                + 'рекомендации и детское меню.',
            },
            questions: [
              { text: 'Как часто обновляется стоп-лист?', options: ['Раз в неделю', 'Каждое утро и перед вечерней сменой', 'Никогда'], correct: 1 },
              { text: 'Не знаешь аллергены блюда:', options: ['Придумываю', 'Уточняю у повара', 'Говорю «наверное, нет»'], correct: 1 },
              { text: 'Разделы меню:', options: ['Только напитки', 'Закуски, супы, горячее, гарниры, напитки, десерты', 'Только горячее'], correct: 1 },
            ],
          },
          {
            title: 'Приём заказа и работа с POS',
            material: {
              type: 'video', url: 'demo:pos-training', watch: 80,
            },
            questions: [
              { text: 'Что делаем сразу после приёма заказа?', options: ['Вносим в POS', 'Ждём конца смены', 'Держим в голове'], correct: 0 },
              { text: 'Гость просит убрать позицию из внесённого заказа:', options: ['Отказываем', 'Оформляем отмену через администратора', 'Убираем тихо сами'], correct: 1 },
              { text: 'Модификаторы («без лука») вносим:', options: ['В комментарий к позиции в POS', 'В голову', 'На салфетку'], correct: 0 },
            ],
          },
          {
            title: 'Работа с гостем: конфликты и жалобы',
            material: {
              type: 'text',
              text: 'Алгоритм жалобы: 1) выслушать не перебивая; 2) извиниться от лица заведения; '
                + '3) предложить решение (замена, скидка, комплимент) в рамках своих полномочий; '
                + '4) если не хватает полномочий — сразу позвать администратора; 5) убедиться, что '
                + 'гость доволен решением. Спорить и оправдываться нельзя.',
            },
            questions: [
              { text: 'Первый шаг при жалобе:', options: ['Выслушать не перебивая', 'Объяснить, что гость не прав', 'Позвать охрану'], correct: 0 },
              { text: 'Не хватает полномочий для решения:', options: ['Сразу позвать администратора', 'Отказать', 'Сделать вид, что не слышал'], correct: 0 },
            ],
          },
        ],
      },
      {
        title: 'Стандарты смены',
        lessons: [
          {
            title: 'Открытие и закрытие смены',
            material: {
              type: 'text',
              text: 'Открытие: сверить стоп-лист и брони, проверить сервировку и чистоту секции, '
                + 'взять разменную книжку/терминал. Закрытие: рассчитать всех гостей, сдать выручку '
                + 'и отчёт, убрать секцию, проверить, что техника выключена, отметиться у администратора.',
            },
            questions: [
              { text: 'Что делаем на открытии смены?', options: ['Сверяем стоп-лист и брони, проверяем секцию', 'Сразу идём на перерыв', 'Ждём первого гостя ничего не делая'], correct: 0 },
              { text: 'На закрытии смены выручку:', options: ['Сдаём с отчётом администратору', 'Оставляем на столе', 'Забираем себе'], correct: 0 },
            ],
          },
          {
            title: 'Санитария и чистота',
            material: {
              type: 'text',
              text: 'Руки моем при входе в зал, после уборки, перед подачей. Столы протираем сразу '
                + 'после ухода гостей. Разделяем ветоши по зонам. Испорченный продукт не подаём — '
                + 'сообщаем повару и администратору. Личные вещи — только в шкафчике.',
            },
            questions: [
              { text: 'Когда моем руки?', options: ['При входе в зал, после уборки, перед подачей', 'Раз в смену', 'Только дома'], correct: 0 },
              { text: 'Заметил испорченный продукт:', options: ['Сообщить повару и администратору', 'Подать гостю', 'Промолчать'], correct: 0 },
            ],
          },
        ],
      },
    ],
    attestation: [
      { text: 'За сколько секунд встречаем гостя?', options: ['30 секунд', '2 минуты', 'Как получится'], correct: 0 },
      { text: 'Где пользуемся личным телефоном?', options: ['В зале', 'В подсобке', 'Везде'], correct: 1 },
      { text: 'Стоп-лист сверяем:', options: ['До открытия смены', 'В конце смены', 'Раз в месяц'], correct: 0 },
      { text: 'Аллергены блюда неизвестны:', options: ['Уточнить у повара', 'Придумать', 'Пропустить стол'], correct: 0 },
      { text: 'Заказ принят — далее:', options: ['Внести в POS', 'Подождать', 'Не вносить'], correct: 0 },
      { text: 'Первый шаг при жалобе гостя:', options: ['Выслушать не перебивая', 'Спорить', 'Позвать охрану'], correct: 0 },
      { text: 'Кто обслуживает еду на дорожках боулинга?', options: ['Официант зоны', 'Никто', 'Бармен'], correct: 0 },
      { text: 'На закрытии смены выручку:', options: ['Сдаём с отчётом', 'Оставляем на столе', 'Забираем себе'], correct: 0 },
    ],
  });

  // ============ КАССИР (опубликована) ============
  const kassir = buildTrajectory({
    position: 'Кассир', status: 'active',
    pre: [
      ...PRE_COMMON,
      {
        title: 'Обязанности кассира', type: 'text',
        text: 'Кассир принимает оплату (наличные, карта, QR, сертификаты), оформляет брони дорожек и '
          + 'караоке, выдаёт разменную карту боулинга, ведёт кассовую дисциплину, закрывает смену '
          + 'с отчётом. KPI: отсутствие расхождений по кассе, скорость обслуживания очереди, '
          + 'корректность броней.',
      },
    ],
    blocks: [
      {
        title: 'Welcome',
        lessons: [
          {
            title: 'Ценности и стандарты сервиса',
            material: {
              type: 'text',
              text: 'Кассир — первое и последнее лицо, которое видит гость. Приветствуем, называем '
                + 'сумму чётко, проговариваем сдачу вслух, благодарим. Очередь не игнорируем: '
                + 'киваем ждущим, что видим их. Ошибку в чеке признаём и исправляем сразу.',
            },
            questions: [
              { text: 'Сдачу проговариваем:', options: ['Вслух', 'Про себя', 'Не проговариваем'], correct: 0 },
              { text: 'Заметили ошибку в чеке:', options: ['Признать и исправить сразу', 'Сделать вид, что так и надо', 'Свалить на гостя'], correct: 0 },
            ],
          },
          {
            title: 'Внешний вид и дисциплина',
            material: {
              type: 'text',
              text: 'Форма, бейдж, опрятность. Личный телефон — в подсобке. Касса не оставляется без '
                + 'присмотра. Разговоры на отвлечённые темы при гостях недопустимы.',
            },
            questions: [
              { text: 'Кассу можно оставить без присмотра?', options: ['Нет', 'Да, ненадолго', 'Да, если очередь маленькая'], correct: 0 },
              { text: 'Личный телефон:', options: ['В подсобке', 'На кассе', 'В руках всегда'], correct: 0 },
            ],
          },
        ],
      },
      {
        title: 'Касса и оплата',
        lessons: [
          {
            title: 'Открытие и закрытие кассовой смены',
            material: {
              type: 'text',
              text: 'Открытие: принять разменный фонд, пересчитать, внести в систему, проверить '
                + 'терминал и чековую ленту. Закрытие: снять Z-отчёт, пересчитать наличные, '
                + 'свести с отчётом системы, оформить инкассацию, зафиксировать расхождения '
                + '(если есть) и сообщить администратору.',
            },
            questions: [
              { text: 'Что делаем на открытии?', options: ['Принять и пересчитать разменный фонд', 'Сразу продавать', 'Ничего'], correct: 0 },
              { text: 'Расхождение по кассе на закрытии:', options: ['Зафиксировать и сообщить администратору', 'Доложить из своих', 'Промолчать'], correct: 0 },
            ],
          },
          {
            title: 'Приём оплаты: наличные, карта, QR',
            material: {
              type: 'video', url: 'demo:payments', watch: 80,
            },
            questions: [
              { text: 'Карта не проходит:', options: ['Предложить другой способ, не винить гостя', 'Сказать, что карта плохая', 'Отправить гостя в банк'], correct: 0 },
              { text: 'Приняли наличные — когда убираем в кассу?', options: ['После того как отсчитали и отдали сдачу', 'Сразу, сдачу потом', 'Как получится'], correct: 0 },
              { text: 'Оплата по QR подтверждается:', options: ['Уведомлением в системе/терминале', 'На слово гостя', 'Никак'], correct: 0 },
            ],
          },
          {
            title: 'Возвраты, отмены и брони',
            material: {
              type: 'text',
              text: 'Возврат и отмену чека проводим только с подтверждения администратора, по '
                + 'регламенту. Бронь дорожки/кабинета: время, число гостей, депозит, контакт. '
                + 'Депозит фиксируем в системе. При опоздании гостя больше чем на 15 минут — '
                + 'уточняем у администратора, держать ли бронь.',
            },
            questions: [
              { text: 'Возврат чека проводим:', options: ['С подтверждения администратора по регламенту', 'Сами когда попросят', 'Никогда'], correct: 0 },
              { text: 'Что фиксируем при брони?', options: ['Время, число гостей, депозит, контакт', 'Только имя', 'Ничего, запомним'], correct: 0 },
            ],
          },
        ],
      },
    ],
    attestation: [
      { text: 'Сдачу гостю:', options: ['Проговариваем вслух', 'Молча кладём', 'Округляем в свою пользу'], correct: 0 },
      { text: 'Кассу без присмотра:', options: ['Не оставляем', 'Можно ненадолго', 'Без разницы'], correct: 0 },
      { text: 'Расхождение по кассе:', options: ['Фиксируем и сообщаем администратору', 'Докладываем свои', 'Скрываем'], correct: 0 },
      { text: 'Карта гостя не проходит:', options: ['Предлагаем другой способ спокойно', 'Обвиняем гостя', 'Зовём охрану'], correct: 0 },
      { text: 'Возврат чека:', options: ['Только с подтверждения администратора', 'Сами', 'Никогда'], correct: 0 },
      { text: 'При брони фиксируем:', options: ['Время, гостей, депозит, контакт', 'Только имя', 'Ничего'], correct: 0 },
    ],
  });

  // ============ АДМИНИСТРАТОР (черновик — незаполненный) ============
  const admin = buildTrajectory({
    position: 'Администратор', status: 'draft',
    pre: [{ title: 'Обязанности администратора', type: 'text', text: 'Черновик — заполнить.' }],
    blocks: [
      { title: 'Управление залом', lessons: [
        { title: 'Рассадка и контроль столов', material: { type: 'text', text: '' }, questions: [] },
      ] },
    ],
    attestation: null,
  });

  return { officiant, kassir, admin };
}

// ---- демо-сотрудники ----
function createEmployee(o: {
  login: string; name: string; positionId: string; phone: string; startDate: string;
}) {
  const userId = uuid(); const empId = uuid();
  run('INSERT INTO users (id, login, password_hash, role, employee_id) VALUES (?,?,?,?,?)',
    userId, o.login, hashPassword(`${o.login}123`), 'employee', empId);
  run(`INSERT INTO employees (id, user_id, full_name, position_id, phone, start_date, stage, created_at)
       VALUES (?,?,?,?,?,?, 'intern', ?)`,
    empId, userId, o.name, o.positionId, o.phone, o.startDate, stamp());
  takePreSnapshot(empId);
  return empId;
}
function viewAllPre(empId: string) {
  for (const itemId of preSnapshotOf(empId))
    run('INSERT INTO pre_onboarding_views (id, employee_id, item_id, viewed_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING',
      uuid(), empId, itemId, stamp());
  run('UPDATE employees SET pre_onboarding_done = 1 WHERE id = ?', empId);
}
/** Закрыть урок «как будто прошёл»: материал + сданная попытка теста из снимка. */
function passLesson(empId: string, lessonId: string) {
  const snap = snapshotOf(empId);
  const lesson = snap ? findLesson(snap, lessonId) : null;
  if (!lesson) return;
  run('UPDATE lesson_progress SET material_done = 1, video_pct = 100 WHERE employee_id = ? AND lesson_id = ?',
    empId, lessonId);
  if (lesson.test) {
    const n = (one<{ n: number }>('SELECT COALESCE(MAX(attempt_no),0) n FROM test_attempts WHERE employee_id=? AND test_id=?', empId, lesson.test.test_id)!.n) + 1;
    run('INSERT INTO test_attempts (id, employee_id, test_id, attempt_no, answers, score_pct, passed, submitted_at) VALUES (?,?,?,?,?,100,1,?)',
      uuid(), empId, lesson.test.test_id, n, '[]', stamp());
  }
  markLessonPassedIfReady(empId, lessonId);
}

type Traj = { positionId: string; lessonIds: string[]; attBlockId: string | null };
type TargetState = 'intern' | 'intern-ready' | 'onboarding' | 'onboarding-overdue' | 'completed' | 'archived';

const days = (n: number) => {
  const d = new Date(today() + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function completeAttestation(empId: string, when: string) {
  const snap = snapshotOf(empId);
  const att = snap ? attestationBlockOf(snap) : null;
  if (!att?.test) return;
  run('INSERT INTO test_attempts (id, employee_id, test_id, attempt_no, answers, score_pct, passed, submitted_at) VALUES (?,?,?,1,?,100,1,?)',
    uuid(), empId, att.test.test_id, '[]', when);
  run(`UPDATE employees SET stage = 'completed', completed_at = ? WHERE id = ?`, when, empId);
}

function mkEmp(o: {
  login: string; name: string; traj: Traj; phone: string;
  state: TargetState; lessonsPassed?: number; startOffset?: number;
}) {
  const start = days(o.startOffset ?? 0);
  const empId = createEmployee({ login: o.login, name: o.name, positionId: o.traj.positionId, phone: o.phone, startDate: start });

  if (o.state === 'intern') return empId;
  viewAllPre(empId); // все остальные состояния прошли пре-онбординг
  if (o.state === 'intern-ready') return empId;

  run('UPDATE employees SET internship_passed = 1 WHERE id = ?', empId);
  tryOpenOnboarding(empId);

  const openedAt = o.state === 'completed' ? days((o.startOffset ?? -20) + 4)
    : o.state === 'onboarding-overdue' ? days(-18) : days((o.startOffset ?? -3) + 2);
  run('UPDATE employees SET onboarding_opened_at = ?, onboarding_due_date = ? WHERE id = ?',
    openedAt + 'T09:00:00Z', addDaysStr(openedAt, 14), empId);

  const toPass = o.state === 'completed' ? o.traj.lessonIds.length : Math.min(o.lessonsPassed ?? 2, o.traj.lessonIds.length);
  o.traj.lessonIds.slice(0, toPass).forEach((l) => passLesson(empId, l));

  if (o.state === 'completed')
    completeAttestation(empId, addDaysStr(openedAt, 8) + 'T15:00:00Z');
  if (o.state === 'archived')
    run(`UPDATE employees SET stage = 'archived', archived_at = ? WHERE id = ?`, days(-2) + 'T12:00:00Z', empId);

  return empId;
}
function addDaysStr(date: string, n: number) {
  const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function seed() {
  run('INSERT INTO users (id, login, password_hash, role) VALUES (?,?,?,?)', uuid(), 'admin', hashPassword('admin123'), 'admin');
  run('INSERT INTO users (id, login, password_hash, role) VALUES (?,?,?,?)', uuid(), 'hr', hashPassword('hr123'), 'hr');

  const { officiant, kassir } = seedContent();
  const O = officiant, K = kassir;

  // именованные для сценария демо
  mkEmp({ login: 'ivan', name: 'Иван Новиков', traj: O, phone: '+79990000001', state: 'intern', startOffset: 1 });
  mkEmp({ login: 'petr', name: 'Пётр Захаров', traj: O, phone: '+79990000002', state: 'intern-ready', startOffset: 0 });
  mkEmp({ login: 'olga', name: 'Ольга Титова', traj: O, phone: '+79990000003', state: 'onboarding', lessonsPassed: 4, startOffset: -4 });
  mkEmp({ login: 'sveta', name: 'Светлана Рожкова', traj: O, phone: '+79990000004', state: 'completed', startOffset: -24 });

  // массовка для воронки и таблицы
  const bulk: Array<[string, string, Traj, TargetState, number, number]> = [
    ['a1', 'Артём Белов', O, 'intern', 0, 2],
    ['a2', 'Марина Гусева', O, 'intern-ready', 0, -1],
    ['a3', 'Никита Орлов', O, 'onboarding', 2, -3],
    ['a4', 'Дарья Фомина', O, 'onboarding', 6, -6],
    ['a5', 'Егор Кузьмин', O, 'onboarding-overdue', 3, -20],
    ['a6', 'Юлия Панова', O, 'completed', 9, -30],
    ['a7', 'Сергей Лапин', O, 'archived', 3, -25],
    ['k1', 'Алина Серова', K, 'onboarding', 1, -2],
    ['k2', 'Роман Дьяков', K, 'onboarding', 3, -7],
    ['k3', 'Вера Ильина', K, 'onboarding-overdue', 2, -19],
    ['k4', 'Павел Громов', K, 'completed', 5, -28],
    ['k5', 'Ксения Быкова', K, 'intern-ready', 0, 0],
  ];
  bulk.forEach(([login, name, traj, state, lp, off], i) =>
    mkEmp({ login, name, traj, phone: `+7999111${String(1000 + i).slice(1)}`, state, lessonsPassed: lp, startOffset: off }));

  clearEvents(); // журнал событий стартует чистым — наполняется во время демо
}

if (process.argv[1]?.endsWith('seed.ts')) {
  migrate(); wipe(); migrate(); seed();
  console.log('demo data seeded ->', today());
}
