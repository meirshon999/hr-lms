import { randomBytes } from 'node:crypto';
import { migrate, one, run, uuid, wipe } from './db.ts';
import { hashPassword } from './auth.ts';
import { stamp, today } from './clock.ts';
import { markLessonPassedIfReady, takePreSnapshot, tryOpenOnboarding } from './domain.ts';
import { audit } from './audit.ts';
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

function buildTrajectory(def: TrajectoryDef): Traj {
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
  return { positionId: posId, positionName: def.position, lessonIds, attBlockId: def.attestation ? attBlockId : null };
}

// ---- точки сети ----
export const LOCATIONS = [
  { name: 'PINGWIN Premium', city: null },
  { name: 'PINGWIN Premium karaoke', city: null },
  { name: 'PINGWIN Friends', city: null },
];

function seedLocations(): string[] {
  return LOCATIONS.map((l, i) => {
    const id = uuid();
    run('INSERT INTO locations (id, name, city, ord, is_active) VALUES (?,?,?,?,1)', id, l.name, l.city, i + 1);
    return id;
  });
}

/**
 * Корректный ИИН для демо-сотрудника: контрольная сумма настоящая, иначе форма
 * найма справедливо откажется его принимать и демо развалится.
 */
function demoIin(n: number): string {
  const base = `9${String(n % 10)}0315` + '3' + String(10000 + (n % 9000)).slice(1);
  const d = [...base].map(Number);
  const w1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const w2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];
  const sum = (w: number[]) => w.reduce((s, k, i) => s + d[i] * k, 0) % 11;
  let c = sum(w1);
  if (c === 10) c = sum(w2);
  if (c === 10) return demoIin(n + 7); // такой номер невалиден по стандарту — берём следующий
  return base + String(c);
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
              { text: 'Гость сел за стол. За какое время нужно к нему подойти?', options: ['Когда освободится ваша секция', 'После того как он позовёт', 'В течение 30 секунд', 'В течение 3 минут'], correct: 2 },
              { text: 'Гость просит совет, что взять к стейку. Как ответить?', options: ['Назвать две-три позиции и коротко объяснить выбор', 'Спросить «что-нибудь ещё будете?»', 'Дать меню и отойти подумать', 'Сказать, что у нас всё вкусное'], correct: 0 },
              { text: 'Блюдо задерживается, гость пока молчит. Ваши действия?', options: ['Ждать: пожалуется — тогда и разберёмся', 'Подойти самому, объяснить и назвать срок', 'Это зона кухни, не вмешиваться', 'Сказать администратору и забыть'], correct: 1 },
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
              { text: 'Где в смену можно пользоваться личным телефоном?', options: ['В зале, если нет гостей', 'За барной стойкой', 'Только в подсобке', 'На кассе между гостями'], correct: 2 },
              { text: 'Вы поняли, что опаздываете на смену на 20 минут.', options: ['Предупредить администратора сразу, как стало понятно', 'Прийти и объяснить на месте', 'Попросить коллегу отметить приход', 'Ничего, 20 минут не критично'], correct: 0 },
              { text: 'Чем начинается рабочая смена?', options: ['Уборкой своей секции', 'Брифингом: стоп-лист, брони, спецпредложения', 'Проверкой кассы', 'Пересчётом посуды'], correct: 1 },
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
              { text: 'Гости на дорожке боулинга просят принести еду. Кто принимает заказ?', options: ['Бармен', 'Администратор', 'Официант зоны', 'На дорожки еду не подаём'], correct: 2 },
              { text: 'Как понять, что блюдо готово к подаче?', options: ['По экрану заказов у выдачи', 'По времени с момента заказа', 'Повар позовёт по имени', 'Подходить и спрашивать каждые пять минут'], correct: 0 },
            ],
          },
          {
            title: 'Безопасность и эвакуация',
            material: {
              type: 'video', url: 'demo:safety', watch: 90,
            },
            questions: [
              { text: 'В зале запахло гарью. Первое действие?', options: ['Самому найти источник', 'Сообщить администратору и действовать по инструкции', 'Открыть окна и продолжить работу', 'Вывести гостей на улицу самостоятельно'], correct: 1 },
              { text: 'Эвакуационный выход в вашей секции заставлен стульями.', options: ['Убрать в конце смены', 'Это зона уборщиков', 'Освободить проход и сообщить администратору', 'Оставить: стулья легко отодвинуть'], correct: 2 },
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
              { text: 'Когда сверяют стоп-лист?', options: ['Раз в неделю на планёрке', 'Утром и перед вечерней сменой', 'Когда блюдо закончилось', 'В начале месяца'], correct: 1 },
              { text: 'Гость спрашивает про орехи в блюде, вы не уверены.', options: ['Ответить по описанию в меню', 'Сказать, что скорее всего нет', 'Предложить другое блюдо', 'Уточнить у повара и вернуться с ответом'], correct: 3 },
              { text: 'Топ-3 позиции для рекомендации официант должен:', options: ['Знать наизусть', 'Смотреть в меню при госте', 'Уточнять у бармена', 'Выбирать по своему вкусу'], correct: 0 },
            ],
          },
          {
            title: 'Приём заказа и работа с POS',
            material: {
              type: 'video', url: 'demo:pos-training', watch: 80,
            },
            questions: [
              { text: 'Заказ принят. Что дальше?', options: ['Запомнить и внести, когда будет время', 'Внести в POS сразу', 'Передать на кухню устно', 'Записать в блокнот до конца обслуживания'], correct: 1 },
              { text: 'Гость просит убрать позицию из уже внесённого заказа.', options: ['Удалить позицию самому в POS', 'Договориться с кухней напрямую', 'Оформить отмену по регламенту через администратора', 'Отказать: заказ уже в работе'], correct: 2 },
              { text: 'Гость просит блюдо без лука. Куда это вносится?', options: ['В модификатор или комментарий к позиции в POS', 'Сказать повару устно', 'В общий комментарий к заказу', 'Пометить на чеке'], correct: 0 },
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
              { text: 'Гость недоволен и повышает голос. Первое действие?', options: ['Извиниться и сразу предложить скидку', 'Объяснить, в чём он не прав', 'Выслушать до конца, не перебивая', 'Сразу позвать администратора'], correct: 2 },
              { text: 'Гость требует того, что вы решить не можете.', options: ['Сразу пригласить администратора', 'Пообещать и разобраться потом', 'Отказать, сославшись на правила', 'Предложить компромисс на своё усмотрение'], correct: 0 },
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
              { text: 'Что входит в открытие смены официанта?', options: ['Пересчитать кассу', 'Сверить стоп-лист и брони, проверить свою секцию', 'Принять товар у поставщика', 'Составить график на неделю'], correct: 1 },
              { text: 'Что делать с выручкой в конце смены?', options: ['Оставить в кассе до утра', 'Передать сменщику', 'Внести на карту заведения', 'Сдать администратору с отчётом'], correct: 3 },
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
              { text: 'Когда официант моет руки?', options: ['При входе в зал, после уборки и перед подачей', 'В начале и в конце смены', 'Только после уборки', 'Перед перерывом'], correct: 0 },
              { text: 'Вы заметили продукт с истёкшим сроком.', options: ['Убрать самому и выбросить', 'Сообщить повару и администратору', 'Использовать, если выглядит нормально', 'Отложить и сказать в конце смены'], correct: 1 },
            ],
          },
        ],
      },
    ],
    attestation: [
      { text: 'К гостю за столом подходят в течение:', options: ['2 минут', '30 секунд', '5 минут', 'Как только освободитесь'], correct: 1 },
      { text: 'Личный телефон в смену находится:', options: ['В кармане, беззвучно', 'На рабочей станции', 'В подсобке', 'В зале при отсутствии гостей'], correct: 2 },
      { text: 'Смена официанта начинается:', options: ['С уборки секции', 'С брифинга', 'С пересчёта посуды', 'С приёма кассы'], correct: 1 },
      { text: 'Стоп-лист сверяют:', options: ['В конце смены', 'Раз в месяц', 'До открытия и перед вечерней сменой', 'Когда блюдо закончилось'], correct: 2 },
      { text: 'Состав блюда для гостя с аллергией уточняют:', options: ['У повара', 'В описании меню', 'У администратора', 'У коллеги-официанта'], correct: 0 },
      { text: 'Принятый заказ вносится в POS:', options: ['Сразу', 'В конце обслуживания стола', 'В конце смены', 'Когда напомнит кухня'], correct: 0 },
      { text: 'При жалобе гостя первым делом:', options: ['Спорят', 'Выслушивают не перебивая', 'Зовут охрану', 'Предлагают скидку'], correct: 1 },
      { text: 'Еду на дорожки боулинга подаёт:', options: ['Бармен', 'Администратор', 'Официант зоны', 'Никто'], correct: 2 },
      { text: 'Выручка официанта в конце смены:', options: ['Остаётся в кассе', 'Сдаётся администратору с отчётом', 'Передаётся сменщику', 'Хранится у официанта'], correct: 1 },
      { text: 'Продукт с истёкшим сроком:', options: ['Убирают молча', 'Сообщают повару и администратору', 'Используют, если выглядит нормально', 'Оставляют до конца смены'], correct: 1 },
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
              { text: 'Как отдают сдачу гостю?', options: ['Молча кладут на поднос', 'Проговаривают сумму вслух', 'Округляют в пользу заведения', 'Спрашивают, нужна ли она'], correct: 1 },
              { text: 'Вы заметили ошибку в уже пробитом чеке.', options: ['Признать и исправить сразу по регламенту', 'Исправить в конце смены', 'Не обращать внимания, если сумма мелкая', 'Списать на сбой терминала'], correct: 0 },
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
              { text: 'Нужно отойти от кассы на минуту.', options: ['Можно, если очередь маленькая', 'Можно, если закрыть ящик', 'Нельзя: передать кассу сменщику или закрыть смену', 'Можно, если рядом коллега'], correct: 2 },
              { text: 'Личный телефон кассира в смену находится:', options: ['На кассе экраном вниз', 'В кармане', 'В подсобке', 'В руках, если ждём гостя'], correct: 2 },
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
              { text: 'С чего начинается смена кассира?', options: ['Сразу начать продавать', 'Принять и пересчитать разменный фонд', 'Пересчитать выручку', 'Проверить стоп-лист'], correct: 1 },
              { text: 'На закрытии обнаружено расхождение по кассе.', options: ['Доложить недостачу из своих денег', 'Зафиксировать и сообщить администратору', 'Списать на ошибку терминала', 'Пересчитать и промолчать, если сумма мелкая'], correct: 1 },
            ],
          },
          {
            title: 'Приём оплаты: наличные, карта, QR',
            material: {
              type: 'video', url: 'demo:payments', watch: 80,
            },
            questions: [
              { text: 'Карта гостя не проходит с третьей попытки.', options: ['Спокойно предложить другой способ оплаты', 'Сказать, что карта заблокирована', 'Отправить гостя в банк', 'Попросить оплатить наличными'], correct: 0 },
              { text: 'Когда полученные наличные убирают в ящик?', options: ['Сразу, сдачу отсчитывают потом', 'После того как отсчитали и отдали сдачу', 'В конце обслуживания очереди', 'Как удобнее'], correct: 1 },
              { text: 'Оплата по QR считается принятой:', options: ['Когда гость показал экран телефона', 'Когда пришло подтверждение в систему или терминал', 'Со слов гостя', 'Когда гость назвал сумму'], correct: 1 },
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
              { text: 'Возврат по чеку проводится:', options: ['По подтверждению администратора и регламенту', 'Кассиром самостоятельно по просьбе гостя', 'Только на следующий день', 'Возвраты не делаются'], correct: 0 },
              { text: 'Что фиксируют при бронировании?', options: ['Только имя гостя', 'Имя и время', 'Время, число гостей, депозит и контакт', 'Ничего, бронь запоминают'], correct: 2 },
            ],
          },
        ],
      },
    ],
    attestation: [
      { text: 'Сдачу гостю:', options: ['Кладут молча', 'Проговаривают вслух', 'Округляют', 'Отдают без пересчёта'], correct: 1 },
      { text: 'Кассу без присмотра:', options: ['Не оставляют', 'Можно ненадолго', 'Можно при малой очереди', 'Можно, если рядом коллега'], correct: 0 },
      { text: 'Разменный фонд принимают:', options: ['В начале смены с пересчётом', 'В конце смены', 'Раз в неделю', 'Не принимают вообще'], correct: 0 },
      { text: 'Расхождение по кассе:', options: ['Докладывают из своих', 'Фиксируют и сообщают администратору', 'Списывают на терминал', 'Оставляют до утра'], correct: 1 },
      { text: 'Карта гостя не проходит:', options: ['Спокойно предлагают другой способ', 'Говорят, что карта плохая', 'Зовут администратора сразу', 'Отправляют в банк'], correct: 0 },
      { text: 'Возврат по чеку:', options: ['Проводит кассир сам по просьбе гостя', 'Проводят по подтверждению администратора', 'Не проводится никогда', 'Только на следующий день'], correct: 1 },
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
let iinSeq = 0;
function createEmployee(o: {
  login: string; name: string; positionId: string; locationId: string; phone: string; startDate: string;
}) {
  const userId = uuid(); const empId = uuid();
  run('INSERT INTO users (id, login, password_hash, role, employee_id) VALUES (?,?,?,?,?)',
    userId, o.login, hashPassword(`${o.login}123`), 'employee', empId);
  run(`INSERT INTO employees (id, user_id, iin, full_name, position_id, location_id, phone, start_date, stage, created_at)
       VALUES (?,?,?,?,?,?,?,?, 'intern', ?)`,
    empId, userId, demoIin(++iinSeq), o.name, o.positionId, o.locationId, o.phone, o.startDate, stamp());
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

type Traj = { positionId: string; positionName: string; lessonIds: string[]; attBlockId: string | null };
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
  login: string; name: string; traj: Traj; phone: string; locationId: string;
  state: TargetState; lessonsPassed?: number; startOffset?: number;
}) {
  const start = days(o.startOffset ?? 0);
  const empId = createEmployee({
    login: o.login, name: o.name, positionId: o.traj.positionId,
    locationId: o.locationId, phone: o.phone, startDate: start,
  });
  // журнал HR: сид повторяет те же записи, что оставили бы роуты
  audit('hr', 'hire', empId, `${o.name}, ${o.traj.positionName}, выход ${start}`,
    addDaysStr(start, -1) + 'T10:15:00Z');

  if (o.state === 'intern') return empId;
  viewAllPre(empId); // все остальные состояния прошли пре-онбординг
  if (o.state === 'intern-ready') return empId;

  run('UPDATE employees SET internship_passed = 1 WHERE id = ?', empId);
  tryOpenOnboarding(empId);
  audit('hr', 'internship_passed', empId, 'онбординг открыт', addDaysStr(start, 3) + 'T18:40:00Z');

  const openedAt = o.state === 'completed' ? days((o.startOffset ?? -20) + 4)
    : o.state === 'onboarding-overdue' ? days(-18) : days((o.startOffset ?? -3) + 2);
  run('UPDATE employees SET onboarding_opened_at = ?, onboarding_due_date = ? WHERE id = ?',
    openedAt + 'T09:00:00Z', addDaysStr(openedAt, 14), empId);

  const toPass = o.state === 'completed' ? o.traj.lessonIds.length : Math.min(o.lessonsPassed ?? 2, o.traj.lessonIds.length);
  o.traj.lessonIds.slice(0, toPass).forEach((l) => passLesson(empId, l));

  if (o.state === 'completed')
    completeAttestation(empId, addDaysStr(openedAt, 8) + 'T15:00:00Z');
  if (o.state === 'archived') {
    run(`UPDATE employees SET stage = 'archived', archived_at = ? WHERE id = ?`, days(-2) + 'T12:00:00Z', empId);
    audit('hr', 'archive', empId, '', days(-2) + 'T12:00:00Z');
  }

  return empId;
}
function addDaysStr(date: string, n: number) {
  const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * ОБРАЗЕЦ ТРАЕКТОРИИ ОФИЦИАНТА.
 *
 * Каркас без содержимого: блоки, уроки и признаки «свой на каждой точке» стоят,
 * а материалы и тесты HR заводит сам. Так у него перед глазами рабочий пример
 * того, как устроена траектория, и не приходится собирать её с чистого листа.
 */
const WAITER_SAMPLE: Array<{ block: string; lessons: Array<[string, boolean]> }> = [
  { block: 'Welcome', lessons: [
    ['Ценности и стандарты сервиса', false],
    ['Внешний вид и дисциплина', false],
  ] },
  { block: 'Знакомство с объектом', lessons: [
    ['Зоны зала, бар, кухня', true],
    ['Эвакуация и безопасность', true],
  ] },
  { block: 'Ввод в должность', lessons: [
    ['Меню и стоп-лист', true],
    ['Приём заказа и работа с POS', false],
    ['Подача блюд и напитков', false],
    ['Работа с гостем, конфликты и жалобы', false],
  ] },
  { block: 'Стандарты смены', lessons: [
    ['Открытие смены', true],
    ['Закрытие смены', true],
    ['Санитария', false],
  ] },
];

const WAITER_PRE = [
  'О Pingwin Premium и истории сети',
  'Форматы: ресторан, боулинг, караоке',
  'Оргструктура: кто за что отвечает',
  'Должностные обязанности официанта',
];

function seedSample() {
  const posId = uuid();
  run('INSERT INTO positions (id, name) VALUES (?, ?)', posId, 'Официант');
  const trajId = uuid();
  run(`INSERT INTO trajectories (id, position_id, status) VALUES (?, ?, 'draft')`, trajId, posId);

  WAITER_PRE.forEach((title, i) =>
    run(`INSERT INTO pre_onboarding_items (id, trajectory_id, ord, title, content_type, text_body)
         VALUES (?,?,?,?, 'text', ?)`, uuid(), trajId, i + 1, title, ''));

  WAITER_SAMPLE.forEach((b, bi) => {
    const blockId = uuid();
    run('INSERT INTO blocks (id, trajectory_id, ord, title, kind) VALUES (?,?,?,?,?)',
      blockId, trajId, bi + 1, b.block, 'regular');
    b.lessons.forEach(([title, perLocation], li) =>
      run('INSERT INTO lessons (id, block_id, ord, title, everywhere, content_per_location) VALUES (?,?,?,?,1,?)',
        uuid(), blockId, li + 1, title, perLocation ? 1 : 0));
  });

  run('INSERT INTO blocks (id, trajectory_id, ord, title, kind) VALUES (?,?,?,?,?)',
    uuid(), trajId, 999, 'Аттестация', 'attestation');
}

/**
 * Первые два аккаунта: администратор и кадровик. Работать HR должен под своим,
 * а не под административным — иначе в журнале не отличить, кто что сделал.
 *
 * Пароль можно задать переменной окружения. Тогда смена при первом входе не
 * требуется: пароль выбрал владелец сервера, он не временный. Случайный —
 * временный по определению, его меняют сразу.
 */
function seedUser(login: string, role: 'admin' | 'hr', envVar: string): string {
  const chosen = process.env[envVar];
  const password = chosen || randomBytes(6).toString('base64url');
  run('INSERT INTO users (id, login, password_hash, role, must_change_password) VALUES (?,?,?,?,?)',
    uuid(), login, hashPassword(password), role, chosen ? 0 : 1);
  return chosen ? `${password}  (из ${envVar})` : `${password}  (сменить при первом входе)`;
}

export function seed(opts: { demo?: boolean } = {}) {
  const locationIds = seedLocations();

  if (!opts.demo) {
    seedSample();
    console.log(`  вход admin: ${seedUser('admin', 'admin', 'LMS_ADMIN_PASSWORD')}`);
    console.log(`  вход hr:    ${seedUser('hr', 'hr', 'LMS_HR_PASSWORD')}`);
    return;
  }

  // ---------- дальше только тестовый сервер ----------
  run('INSERT INTO users (id, login, password_hash, role) VALUES (?,?,?,?)', uuid(), 'admin', hashPassword('admin123'), 'admin');
  run('INSERT INTO users (id, login, password_hash, role) VALUES (?,?,?,?)', uuid(), 'hr', hashPassword('hr123'), 'hr');

  const { officiant, kassir } = seedContent();
  const O = officiant, K = kassir;
  const [L1, L2, L3] = locationIds;

  // именованные для сценария демо
  mkEmp({ login: 'ivan', name: 'Иван Новиков', traj: O, locationId: L1, phone: '+79990000001', state: 'intern', startOffset: 1 });
  mkEmp({ login: 'petr', name: 'Пётр Захаров', traj: O, locationId: L1, phone: '+79990000002', state: 'intern-ready', startOffset: 0 });
  mkEmp({ login: 'olga', name: 'Ольга Титова', traj: O, locationId: L2, phone: '+79990000003', state: 'onboarding', lessonsPassed: 4, startOffset: -4 });
  mkEmp({ login: 'sveta', name: 'Светлана Рожкова', traj: O, locationId: L3, phone: '+79990000004', state: 'completed', startOffset: -24 });

  // массовка для воронки и таблицы
  const bulk: Array<[string, string, Traj, TargetState, number, number, string]> = [
    ['a1', 'Артём Белов', O, 'intern', 0, 2, L1],
    ['a2', 'Марина Гусева', O, 'intern-ready', 0, -1, L2],
    ['a3', 'Никита Орлов', O, 'onboarding', 2, -3, L1],
    ['a4', 'Дарья Фомина', O, 'onboarding', 6, -6, L3],
    ['a5', 'Егор Кузьмин', O, 'onboarding-overdue', 3, -20, L2],
    ['a6', 'Юлия Панова', O, 'completed', 9, -30, L1],
    ['a7', 'Сергей Лапин', O, 'archived', 3, -25, L3],
    ['k1', 'Алина Серова', K, 'onboarding', 1, -2, L1],
    ['k2', 'Роман Дьяков', K, 'onboarding', 3, -7, L2],
    ['k3', 'Вера Ильина', K, 'onboarding-overdue', 2, -19, L3],
    ['k4', 'Павел Громов', K, 'completed', 5, -28, L2],
    ['k5', 'Ксения Быкова', K, 'intern-ready', 0, 0, L3],
  ];
  bulk.forEach(([login, name, traj, state, lp, off, loc], i) =>
    mkEmp({ login, name, traj, locationId: loc, phone: `+7999111${String(1000 + i).slice(1)}`, state, lessonsPassed: lp, startOffset: off }));

  clearEvents(); // журнал событий стартует чистым — наполняется во время демо
}

if (process.argv[1]?.endsWith('seed.ts')) {
  migrate(); wipe(); migrate(); seed();
  console.log('demo data seeded ->', today());
}
