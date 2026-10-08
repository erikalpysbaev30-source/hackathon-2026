"""Builds the pitch deck (RU and KO) as HTML and renders it to PDF with headless Chromium.

Usage: python docs/slides/build_slides.py [repo_url]
Needs: screenshots in docs/slides/img/{plant,exec,incidents,ai}_{ru,ko}.png (scripts/screenshots.js),
       backend/models/metrics.json and effect.json, node + playwright for the PDF step.
"""
import base64
import html as _html
import io
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
IMG = HERE / "img"
OUT = HERE / "out"
sys.path.insert(0, str(ROOT / "backend"))
from app.testdata import analyze  # noqa: E402

REPO = sys.argv[1] if len(sys.argv) > 1 else "https://github.com/<username>/allur-digital-twin"

M = json.loads((ROOT / "backend/models/metrics.json").read_text())
E = json.loads((ROOT / "backend/models/effect.json").read_text())
D = E["days_per_seed"]
R, P = E["reactive"], E["predictive"]
per_day = lambda x: x / D  # noqa: E731  (a day = the plant's 2 working shifts)
SPD = E.get("shifts_per_day", 2)

# business case assumptions (same defaults as the calculator in the app)
DAYS, SHIFTS, MARGIN, DOWNCOST = 250, 2, 700_000, 1_500_000
extra_cars_year = (per_day(P["cars"]) - per_day(R["cars"])) / SPD * SHIFTS * DAYS
hours_saved_year = (per_day(R["breakdown_min"]) - per_day(P["breakdown_min"])) / SPD * SHIFTS * DAYS / 60
money_year = extra_cars_year * MARGIN + hours_saved_year * 0.5 * DOWNCOST

A = analyze()
_q = A["quality"]
_bad_q = [r for r in _q if not r["ok"]]
_min_oee = min(A["lines"], key=lambda r: r["oee"])
_max_down = max(A["downtime"], key=lambda r: r["minutes"])
ru_pct = lambda x: f"{x * 100:.1f}".replace(".", ",")  # noqa: E731
NUM = {
    "d_oee_min": ru_pct(_min_oee["oee"]), "d_oee_max": ru_pct(max(r["oee"] for r in A["lines"])),
    "d_oee_line": _min_oee["line"], "d_oee_date": _min_oee["date"],
    "d_paint": " и ".join(ru_pct(r["rate"]) + "%" for r in _q if r["area"] == "Окраска"),
    "d_paint_ko": ", ".join(f'{r["rate"] * 100:.1f}%' for r in _q if r["area"] == "Окраска"),
    "d_weld_bad": ", ".join(ru_pct(r["rate"]) + f'% ({r["date"]})' for r in _bad_q if r["area"] == "Сварка"),
    "d_weld_bad_ko": ", ".join(f'{r["rate"] * 100:.1f}% ({r["date"]})' for r in _bad_q if r["area"] == "Сварка"),
    "d_nbad": len(_bad_q), "d_nq": len(_q),
    "d_down": f'{_max_down["minutes"]:.0f}', "d_down_eq": _max_down["equip"], "d_down_date": _max_down["date"],
    "d_plan": f'{A["plan_total"]:,.0f}'.replace(",", " "), "d_target": f'{A["plan_target"]:,.0f}'.replace(",", " "),
    "d_gap": f'{A["plan_gap"]:,.0f}'.replace(",", " "), "d_run": f'{A["run_rate_month"]:,.0f}'.replace(",", " "),
    "d_need": f'{A["need_per_shift"]:.0f}', "d_per": f'{A["final_per_shift"]:.0f}', "d_days": A["targets"]["working_days_month"],

    "auc": f'{M["roc_auc"]:.2f}', "lift": f'{M["lift_top10"]:.1f}', "recall": f'{M["recall_top10"] * 100:.0f}',
    "samples": f'{M["samples"]:,}'.replace(",", " "),
    "bd_pct": f'{-E["delta"]["breakdown_min_pct"]:.0f}', "out_pct": f'{E["delta"]["output_pct"]:.1f}',
    "plan_pp": f'{E["delta"]["plan_hit_pp"]:.0f}', "bd_cnt_pct": f'{-E["delta"]["breakdowns_pct"]:.0f}',
    "r_bd": f'{per_day(R["breakdown_min"]):.0f}', "p_bd": f'{per_day(P["breakdown_min"]):.0f}',
    "r_cars": f'{per_day(R["cars"]):.0f}', "p_cars": f'{per_day(P["cars"]):.0f}',
    "r_plan": f'{R["plan_hit"] * 100:.0f}', "p_plan": f'{P["plan_hit"] * 100:.0f}',
    "pm_min": f'{per_day(P["maintenance_min"]):.0f}',
    "extra_cars": f'{extra_cars_year:,.0f}'.replace(",", " "), "hours": f'{hours_saved_year:,.0f}'.replace(",", " "),
    "money": f'{money_year / 1e6:,.0f}'.replace(",", " "), "money_half": f'{money_year / 2e9:,.1f}'.replace(".", ","),
    "money_eok": f'{money_year / 1e8:,.1f}', "money_half_eok": f'{money_year / 2e8:,.1f}', "days": f'{D:g}', "seeds": E["seeds"],
    "margin": f'{MARGIN:,}'.replace(",", " "), "downcost": f'{DOWNCOST:,}'.replace(",", " "),
}

TEAM = {
    "ru": {"school": "Гимназия имени А.М. Горького", "captain": "Алпысбаев Эрик", "members": "Алиев Али, Медеубаев Руслан"},
    "ko": {"school": "А.М. 고리키 김나지움 (Гимназия имени А.М. Горького)", "captain": "Alpysbayev Erik (Алпысбаев Эрик)",
           "members": "Aliyev Ali (Алиев Али), Medeubayev Ruslan (Медеубаев Руслан)"},
}

T = {
    "ru": {
        "event": "Qostanai Industry Hackathon 2026 · Кейс №2 · АО «Группа компаний АЛЛЮР»",
        "title": "Цифровой двойник автомобильного завода",
        "subtitle": "Видеть линию в реальном времени, предсказывать простои и узкие места с помощью ИИ, принимать решения до того, как остановится конвейер",
        "school": "Учебное заведение", "captain": "Капитан", "members": "Участники",
        # problem
        "p_title": "Проблема", "p_lead": "Сотни связанных операций, а картина дня складывается из отчётов после смены",
        "p_items": [
            ("Нет единой картины", "Данные о линиях, складе, ОТК и ремонтах живут в разных системах и таблицах"),
            ("Простои — постфактум", "Об отказе робота узнают, когда конвейер уже стоит; ремонт длиннее планового ТО в 2–4 раза"),
            ("Узкое место «плавает»", "Сегодня это окрасочная камера, завтра — сварка; без аналитики усилия тратятся не там"),
            ("Риски не прогнозируются", "Срыв поставки или рост брака видны, когда план смены уже не спасти"),
        ],
        "p_goal": "Цель кейса: прозрачность производства, меньше простоев оборудования, лучшие управленческие решения",
        # solution
        "s_title": "Решение: цифровой двойник линии", "s_lead": "Живая модель завода, которая повторяет состояние каждого участка и умеет «прокручивать» будущее",
        "s_req": "Требование кейса", "s_how": "Как реализовано в MVP",
        "s_rows": [
            ("Визуализация участков и оборудования", "Интерактивная схема 5 цехов и 15 участков: статус, буферы, склад, анимация потока"),
            ("Мониторинг KPI", "Выпуск/план, темп (JPH), OEE линии и участков, FPY, простои, НЗП — каждую секунду"),
            ("Инциденты и отклонения", "Автоматические инциденты: аварии, нехватка комплектующих, рост брака, риск срыва плана"),
            ("Панель руководителя", "Выпуск vs план, потери по участкам, Парето дефектов, узкие места, склад"),
            ("Прогноз простоев и узких мест (ИИ)", "Индекс здоровья, риск отказа на 4 ч, Монте-Карло прогноз смены, рекомендации ТО"),
            ("Тестовые данные АЛЛЮР", "Вкладка «Данные АЛЛЮР»: OEE, брак, простои и план проверяются по целевым показателям; модель линии откалибрована по этим данным, свои CSV загружаются кнопкой"),
        ],
        # architecture
        "a_title": "Архитектура решения",
        "a_src": "Источники данных", "a_src_items": ["MES / 1С: план, выпуск", "SCADA / ПЛК (OPC UA)", "IoT-датчики (MQTT)", "ТОиР: ремонты, ТО", "Склад (WMS)"],
        "a_gw": "Шлюз интеграции", "a_gw_items": ["REST /api/telemetry", "адаптеры OPC UA / MQTT", "нормализация, буфер"],
        "a_core": "Ядро двойника", "a_core_items": ["модель завода (дискретно-событийная)", "расчёт KPI и OEE", "движок инцидентов", "история состояний"],
        "a_ai": "ИИ-сервисы", "a_ai_items": ["индекс здоровья оборудования", "риск отказа на 4 ч (бустинг)", "Монте-Карло прогноз смены", "what-if и рекомендации"],
        "a_ui": "Интерфейс RU / 한국어", "a_ui_items": ["Цех онлайн", "Панель руководителя", "Инциденты", "ИИ-прогноз и эффект"],
        "a_flow": ["Каждую секунду: сбор состояний участков и датчиков", "Расчёт KPI, OEE и узкого места", "Оценка ИИ: здоровье и риск каждого узла", "Каждые 12 с: прогноз смены и рекомендации"],
        "a_stack": "Стек: Python · FastAPI · WebSocket · scikit-learn · Chart.js · Docker. Открытый код, без лицензий, разворачивается на сервере завода (on-premise).",
        # screens
        "v1_title": "Цех онлайн", "v1_text": ["Схема цехов: сварка → окраска → сборка → ОТК → отгрузка", "Цвет участка = состояние: работа, ожидание, блокировка, авария, ТО, нет комплектующих",
                                              "Пунктирная рамка — текущее узкое место (метод активных периодов)", "Красный кружок — риск отказа по оценке ИИ",
                                              "Кнопки сценариев для демонстрации и ленты инцидентов"],
        "v2_title": "Панель руководителя", "v2_text": ["Выпуск нарастающим итогом против плана", "Прогноз ИИ на конец смены с диапазоном и вероятностью выполнения плана",
                                                       "Потери времени по участкам и причинам", "OEE по участкам, Парето дефектов, доли узких мест", "Запасы комплектующих и ближайшие поставки"],
        "v3_title": "Инциденты и отклонения", "v3_text": ["Аварийная остановка → критичный инцидент с прогнозом времени ремонта", "Нехватка комплектующих и срыв поставки",
                                                          "Всплеск брака одного типа на участке", "Предупреждение ИИ об отказе до поломки", "Риск невыполнения плана смены", "Статусы: открыт → принят → закрыт, экспорт CSV"],
        # AI
        "ai_title": "ИИ: от мониторинга к прогнозу и рекомендациям",
        "ai_steps": [
            ("1. Индекс здоровья", "Модель оценивает скрытый износ узла по вибрации, температуре, току, дрейфу такта и времени с последнего ТО"),
            ("2. Риск отказа на 4 ч", "Градиентный бустинг даёт вероятность поломки каждого участка; причины показываются оператору"),
            ("3. Прогноз смены", "Двойник 16 раз «проигрывает» остаток смены с учётом оценок ИИ: выпуск P10–P90, шанс выполнить план, будущее узкое место"),
            ("4. Рекомендация", "What-if: сравнение «ничего не делать» и «ТО сейчас» — сколько авто и минут простоя это даст"),
        ],
        "ai_metrics": "Качество модели (отложенная выборка)",
        "ai_m": [("ROC-AUC", "{auc}"), ("Точность топ-10% риска выше случайной", "×{lift}"), ("Отказов, пойманных в топ-10%", "{recall}%"), ("Обучающих примеров", "{samples}")],
        "ai_note": "Модели обучены на истории двойника, откалиброванного по тестовым данным АЛЛЮР (120 авто/смену, 2 смены, брак по участкам, оборудование ABB, камеры, конвейеры). На полной истории АЛЛЮР (журналы простоев, ТОиР, датчики) тот же конвейер переобучается без изменения кода.",
        # organizer data
        "d_title": "Тестовые данные АЛЛЮР: что показал двойник",
        "d_lead": "Загрузили таблицы организаторов (01–02.10.2026) и проверили их по целевым показателям кейса",
        "d_cards": [("{d_oee_min}%", "минимальный OEE линии, норма ≥ 85% выполнена"), ("{d_nbad} из {d_nq}", "замеров брака выше нормы 2%"),
                    ("{d_down} мин", "простой {d_down_eq} при лимите 60 мин"), ("{d_plan}", "план по моделям при цели {d_target}")],
        "d_items": [
            "<b>Качество — главный резерв.</b> Окраска: брак {d_paint} при норме 2%; сварка: {d_weld_bad}. Двойник показывает рост брака в окрасочной камере и участок-источник.",
            "<b>OEE в норме:</b> от {d_oee_min}% до {d_oee_max}%. Ближе всего к границе {d_oee_line} {d_oee_date}.",
            "<b>Простои:</b> {d_down_eq} простоял {d_down} мин ({d_down_date}) — 92% суточного лимита. Двойник предупреждает при 45 мин, а ИИ заранее видит риск отказа.",
            "<b>План не сходится:</b> по моделям {d_plan} авто, на {d_gap} меньше цели {d_target}. Темп {d_per} авто/смену × 2 смены × {d_days} дня = {d_run}; для цели нужно {d_need} авто за смену.",
            "<b>Данные расходятся:</b> в 3 из 6 записей время работы линии не совпадает с журналом простоев. Двойник сводит источники в одну картину.",
        ],
        # scenarios
        "sc_title": "Демонстрационные сценарии", "sc_h": ("Сценарий", "Что видит руководитель", "Что предлагает двойник"),
        "sc_rows": [
            ("Авария робота W3", "Участок красный, инцидент «авария» с причиной, перед W3 копятся кузова; через 60 мин — «превышен лимит простоя»", "Прогноз потерь на смену, новое узкое место, вероятность плана"),
            ("Задержка поставки двигателей", "Падает запас, инцидент «срыв поставки», затем A2 «нет комплектующих»", "Предупреждение заранее, когда склад ещё не пуст"),
            ("Брак в окрасочной камере", "Растёт доработка, падает FPY, Парето дефектов показывает «подтёки ЛКП»", "Инцидент «рост брака» с участком-источником"),
            ("Скрытый износ узла A2", "Участок ещё работает, но растут вибрация и температура", "Риск отказа ↑, рекомендация «ТО сейчас» с расчётом эффекта"),
        ],
        # effect
        "e_title": "Эффект для бизнеса", "e_lead": "Сравнили на двойнике две стратегии на одинаковых случайных сценариях ({days} дней × {seeds} прогона)",
        "e_reactive": "Реактивное ТО (ремонт после поломки)", "e_predictive": "Предиктивное ТО по прогнозу двойника",
        "e_kpis": [("−{bd_pct}%", "аварийных простоев"), ("−{bd_cnt_pct}%", "числа поломок"), ("+{out_pct}%", "выпуска без инвестиций в оборудование"), ("+{plan_pp} п.п.", "смен с выполненным планом")],
        "e_rows": [("Аварийные простои, мин/сутки", "{r_bd}", "{p_bd}"), ("Выпуск, авто/сутки", "{r_cars}", "{p_cars}"), ("Смен с выполненным планом", "{r_plan}%", "{p_plan}%"), ("Плановое ТО, мин/сутки", "0", "{pm_min}")],
        "e_money": "Оценка на одну линию в год", "e_money_items": [("+{extra_cars} авто", "дополнительный выпуск"), ("−{hours} ч", "аварийных простоев"), ("≈ {money} млн ₸", "эффект в год")],
        "e_assump": "Допущения: {days_y} рабочих дней, {shifts} смены, маржинальный доход {margin} ₸/авто, стоимость часа простоя линии {downcost} ₸ (учтена 1/2). Параметры меняются в калькуляторе приложения; на пилоте заменяются фактическими данными АЛЛЮР.",
        "e_cons": "Консервативно: даже при эффекте вдвое ниже — ≈ {money_half} млрд ₸ в год. Отраслевые оценки предиктивного ТО: −30…50% простоев.",
        "e_soft": "Дополнительно: прозрачность для руководства, быстрые решения по инцидентам, прослеживаемость брака, единый язык RU/KO для команды",
        # roadmap
        "r_title": "План внедрения",
        "r_steps": [
            ("Этап 1 · 1–2 мес.", "Пилот на одной линии", ["подключение MES/ПЛК и журнала простоев", "калибровка модели по реальным тактам и MTBF", "обучение мастеров и диспетчеров"]),
            ("Этап 2 · 3–4 мес.", "ИИ на реальных данных", ["переобучение моделей на истории АЛЛЮР", "интеграция с ТОиР: заявки на ТО из рекомендаций", "уведомления в Telegram / на смартфон"]),
            ("Этап 3 · 6+ мес.", "Масштабирование", ["все цеха и линии, несколько моделей авто", "цепочка поставок и прослеживаемость по VIN", "3D-модель цеха и планирование смен"]),
        ],
        "r_risks": "Риски и ответы: качество данных → валидация и правила на шлюзе; старое оборудование без датчиков → недорогие IoT-датчики вибрации/тока; принятие персоналом → простой интерфейс на родном языке (RU/KO).",
        # why
        "w_title": "Почему это решение",
        "w_items": [
            ("Работает уже сейчас", "Готовый MVP: запускается одной командой, данные идут в реальном времени"),
            ("ИИ, который советует", "Не только «что сломается», но и «что сделать и сколько это даст»"),
            ("Прозрачная экономика", "Эффект посчитан на модели и проверяется на пилоте"),
            ("Для международной команды", "Интерфейс на русском и корейском языках"),
            ("Открытая архитектура", "Подключается к MES, SCADA, 1С и ТОиР через стандартные протоколы"),
            ("Дёшево масштабировать", "Open-source стек, свой сервер, без лицензий"),
        ],
        "end_title": "Спасибо!", "end_sub": "Готовы показать живую демонстрацию", "repo": "Код", "run": "Запуск: ./run.sh → http://localhost:8000",
    },
    "ko": {
        "event": "Qostanai Industry Hackathon 2026 · 케이스 2 · ALLUR 그룹",
        "title": "자동차 공장 디지털 트윈",
        "subtitle": "라인을 실시간으로 보고, AI로 비가동과 병목을 예측하여 컨베이어가 멈추기 전에 결정합니다",
        "school": "학교", "captain": "팀장", "members": "팀원",
        "p_title": "문제", "p_lead": "수백 개의 연결된 공정, 그러나 현황은 교대가 끝난 뒤 보고서로 파악됩니다",
        "p_items": [
            ("통합된 현황 부재", "라인, 창고, 품질, 정비 데이터가 서로 다른 시스템과 엑셀에 흩어져 있습니다"),
            ("사후 대응", "로봇 고장은 라인이 멈춘 뒤에야 알게 되며, 고장 수리는 계획 정비보다 2~4배 깁니다"),
            ("움직이는 병목", "오늘은 도장 부스, 내일은 용접 — 분석 없이는 개선 노력이 엉뚱한 곳에 쓰입니다"),
            ("예측 없는 리스크", "납품 지연이나 불량 증가는 교대 계획을 지킬 수 없을 때 비로소 보입니다"),
        ],
        "p_goal": "케이스 목표: 생산 투명성 향상, 설비 비가동 감소, 더 나은 경영 의사결정",
        "s_title": "솔루션: 라인 디지털 트윈", "s_lead": "모든 공정의 상태를 그대로 재현하고 미래를 시뮬레이션하는 살아있는 공장 모델",
        "s_req": "케이스 요구사항", "s_how": "MVP 구현 내용",
        "s_rows": [
            ("공정 및 설비 시각화", "5개 공장·15개 공정 인터랙티브 맵: 상태, 버퍼, 창고, 흐름 애니메이션"),
            ("KPI 모니터링", "생산/계획, JPH, 라인·공정 OEE, 직행률, 비가동, 재공 — 매초 갱신"),
            ("이상 및 사고 표시", "고장, 부품 부족, 불량 증가, 계획 미달 위험을 자동으로 감지"),
            ("경영진 대시보드", "생산 대비 계획, 공정별 손실, 불량 파레토, 병목, 재고"),
            ("비가동·병목 예측 (AI)", "설비 건강 지수, 4시간 고장 위험, 몬테카를로 교대 예측, 정비 권고"),
            ("ALLUR 테스트 데이터", "'ALLUR 데이터' 탭: OEE, 불량, 정지, 계획을 목표 지표로 점검하고, 라인 모델을 이 데이터로 보정, CSV 업로드 지원"),
        ],
        "a_title": "솔루션 아키텍처",
        "a_src": "데이터 소스", "a_src_items": ["MES / 1C: 계획, 실적", "SCADA / PLC (OPC UA)", "IoT 센서 (MQTT)", "설비보전(CMMS)", "창고 (WMS)"],
        "a_gw": "연동 게이트웨이", "a_gw_items": ["REST /api/telemetry", "OPC UA / MQTT 어댑터", "정규화, 버퍼링"],
        "a_core": "트윈 코어", "a_core_items": ["공장 모델 (이산 사건)", "KPI·OEE 계산", "사고 엔진", "상태 이력"],
        "a_ai": "AI 서비스", "a_ai_items": ["설비 건강 지수", "4시간 고장 위험 (부스팅)", "몬테카를로 교대 예측", "What-if 및 권고"],
        "a_ui": "인터페이스 RU / 한국어", "a_ui_items": ["실시간 공장", "경영진 대시보드", "이상 및 사고", "AI 예측 및 효과"],
        "a_flow": ["매초: 공정 상태와 센서 수집", "KPI, OEE, 병목 계산", "AI 평가: 설비별 건강 지수와 위험", "12초마다: 교대 예측과 권고"],
        "a_stack": "기술: Python · FastAPI · WebSocket · scikit-learn · Chart.js · Docker. 오픈소스, 라이선스 비용 없음, 공장 서버(온프레미스) 설치.",
        "v1_title": "실시간 공장", "v1_text": ["공장 흐름: 용접 → 도장 → 조립 → 품질 검사 → 출하", "공정 색상 = 상태: 가동, 대기, 막힘, 고장, 정비, 부품 부족",
                                         "점선 테두리 — 현재 병목 공정 (Active period 방법)", "빨간 원 — AI가 평가한 고장 위험", "데모 시나리오 버튼과 사고 피드"],
        "v2_title": "경영진 대시보드", "v2_text": ["누적 생산량 대비 계획", "교대 종료 AI 예측: 범위와 계획 달성 확률", "공정·원인별 손실 시간",
                                              "공정별 OEE, 불량 파레토, 병목 비중", "부품 재고와 다음 입고"],
        "v3_title": "이상 및 사고", "v3_text": ["고장 정지 → 수리 예상 시간과 함께 긴급 사고", "부품 부족 및 납품 지연", "공정별 동일 유형 불량 급증",
                                            "고장 전 AI 사전 경고", "교대 계획 미달 위험", "상태: 미처리 → 확인 → 종료, CSV 내보내기"],
        "ai_title": "AI: 모니터링에서 예측과 권고로",
        "ai_steps": [
            ("1. 설비 건강 지수", "진동, 온도, 전류, 사이클 타임 변화, 마지막 정비 후 경과 시간으로 숨은 마모를 추정"),
            ("2. 4시간 고장 위험", "그래디언트 부스팅이 공정별 고장 확률을 계산하고, 원인을 작업자에게 표시"),
            ("3. 교대 예측", "AI 추정치를 반영해 남은 교대를 16회 시뮬레이션: 생산 P10–P90, 계획 달성 확률, 향후 병목"),
            ("4. 권고", "What-if: '조치 없음'과 '지금 정비'를 비교하여 추가 생산 대수와 비가동 감소를 계산"),
        ],
        "ai_metrics": "모델 성능 (검증 데이터)",
        "ai_m": [("ROC-AUC", "{auc}"), ("상위 10% 위험 정밀도 (무작위 대비)", "×{lift}"), ("상위 10%에서 포착한 고장", "{recall}%"), ("학습 샘플 수", "{samples}")],
        "ai_note": "모델은 ALLUR 테스트 데이터로 보정한 트윈의 이력으로 학습했습니다 (교대당 120대, 2교대, 공정별 불량률, ABB 로봇·도장 부스·컨베이어). ALLUR 전체 이력(비가동 기록, 정비 이력, 센서)으로 코드 변경 없이 같은 파이프라인에서 재학습합니다.",
        "d_title": "ALLUR 테스트 데이터: 트윈 분석 결과",
        "d_lead": "주최 측 표(2026.10.01–02)를 불러와 케이스 목표 지표로 점검했습니다",
        "d_cards": [("{d_oee_min}%", "라인 최저 OEE, 기준 ≥ 85% 충족"), ("{d_nbad}/{d_nq}", "불량률 기준 2% 초과 건수"),
                    ("{d_down}분", "{d_down_eq} 정지, 한도 60분"), ("{d_plan}", "모델별 계획 합계, 목표 {d_target}")],
        "d_items": [
            "<b>품질이 핵심 개선 영역.</b> 도장 불량률 {d_paint_ko} (기준 2%), 용접 {d_weld_bad_ko}. 트윈은 도장 부스의 불량 증가와 발생 공정을 보여 줍니다.",
            "<b>OEE 기준 충족:</b> {d_oee_min}%–{d_oee_max}%. 경계에 가장 가까운 것은 {d_oee_line} {d_oee_date}.",
            "<b>정지:</b> {d_down_eq} {d_down}분 정지 ({d_down_date}) — 일일 한도의 92%. 트윈은 45분에서 경고하고, AI는 고장 위험을 미리 감지합니다.",
            "<b>계획 불일치:</b> 모델별 합계 {d_plan}대로 목표 {d_target}대보다 {d_gap}대 적습니다. 교대당 {d_per}대 × 2교대 × {d_days}일 = {d_run}대; 목표에는 교대당 {d_need}대가 필요합니다.",
            "<b>데이터 불일치:</b> 6건 중 3건에서 라인 가동 시간과 정지 기록이 맞지 않습니다. 트윈은 출처를 하나로 통합합니다.",
        ],
        "sc_title": "데모 시나리오", "sc_h": ("시나리오", "경영진이 보는 것", "트윈의 제안"),
        "sc_rows": [
            ("W3 로봇 고장", "공정이 빨간색, 원인이 표시된 '고장' 사고, W3 앞에 차체 적체; 60분 후 '정지 한도 초과'", "교대 손실 예측, 새 병목, 계획 달성 확률"),
            ("엔진 납품 지연", "재고 감소, '납품 지연' 사고, 이후 A2 '부품 부족'", "창고가 비기 전에 사전 경고"),
            ("도장 부스 품질 이상", "수정 작업 증가, 직행률 하락, 파레토에 '도장 흘림'", "발생 공정이 표시된 '불량 증가' 사고"),
            ("A2 설비 숨은 마모", "공정은 가동 중이지만 진동과 온도가 상승", "고장 위험 ↑, 효과 계산과 함께 '즉시 정비' 권고"),
        ],
        "e_title": "비즈니스 효과", "e_lead": "동일한 무작위 시나리오에서 두 가지 전략을 트윈으로 비교 ({days}일 × {seeds}회)",
        "e_reactive": "사후 정비 (고장 후 수리)", "e_predictive": "트윈 예측 기반 예방 정비",
        "e_kpis": [("−{bd_pct}%", "고장 비가동"), ("−{bd_cnt_pct}%", "고장 건수"), ("+{out_pct}%", "설비 투자 없는 생산 증가"), ("+{plan_pp}%p", "계획 달성 교대")],
        "e_rows": [("고장 비가동, 분/일", "{r_bd}", "{p_bd}"), ("생산량, 대/일", "{r_cars}", "{p_cars}"), ("계획 달성 교대 비율", "{r_plan}%", "{p_plan}%"), ("계획 정비, 분/일", "0", "{pm_min}")],
        "e_money": "1개 라인 연간 추정", "e_money_items": [("+{extra_cars}대", "추가 생산"), ("−{hours}시간", "고장 비가동"), ("≈ {money_eok}억 ₸", "연간 효과")],
        "e_assump": "가정: 연 {days_y} 가동일, {shifts}교대, 대당 공헌이익 {margin} ₸, 라인 비가동 시간당 비용 {downcost} ₸ (1/2 반영). 앱의 계산기에서 변경 가능하며, 파일럿에서 ALLUR 실제 데이터로 대체합니다.",
        "e_cons": "보수적으로 효과가 절반이어도 연간 ≈ {money_half_eok}억 ₸. 업계 추정 예측 정비 효과: 비가동 30~50% 감소.",
        "e_soft": "추가 효과: 경영진 투명성, 사고에 대한 신속한 의사결정, 불량 추적, 러시아어·한국어 공통 화면",
        "r_title": "도입 계획",
        "r_steps": [
            ("1단계 · 1–2개월", "1개 라인 파일럿", ["MES/PLC 및 비가동 기록 연동", "실제 사이클 타임과 MTBF로 모델 보정", "반장·관제 담당자 교육"]),
            ("2단계 · 3–4개월", "실데이터 AI", ["ALLUR 이력으로 모델 재학습", "CMMS 연동: 권고에서 정비 요청 생성", "Telegram / 모바일 알림"]),
            ("3단계 · 6개월+", "확대 적용", ["전 공장·전 라인, 다차종", "공급망 및 VIN 단위 추적", "3D 공장 모델과 교대 계획"]),
        ],
        "r_risks": "리스크와 대응: 데이터 품질 → 게이트웨이 검증 규칙; 센서 없는 노후 설비 → 저가 진동·전류 IoT 센서; 현장 수용성 → 모국어(RU/KO) 간단한 화면.",
        "w_title": "왜 이 솔루션인가",
        "w_items": [
            ("지금 바로 작동", "완성된 MVP: 명령 한 줄로 실행, 실시간 데이터"),
            ("조언하는 AI", "'무엇이 고장 날지'뿐 아니라 '무엇을 하면 얼마나 얻는지'"),
            ("투명한 경제성", "모델로 효과를 계산하고 파일럿에서 검증"),
            ("글로벌 팀을 위해", "러시아어와 한국어 인터페이스"),
            ("개방형 아키텍처", "표준 프로토콜로 MES, SCADA, 1C, CMMS 연동"),
            ("저비용 확장", "오픈소스, 자체 서버, 라이선스 비용 없음"),
        ],
        "end_title": "감사합니다!", "end_sub": "라이브 데모를 보여드리겠습니다", "repo": "코드", "run": "실행: ./run.sh → http://localhost:8000",
    },
}


def fmt(s: str) -> str:
    return s.format(days_y=DAYS, shifts=SHIFTS, **NUM)


def img(name: str) -> str:
    p = IMG / name
    if not p.exists():
        return ""
    return "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode()


def qr_data(url: str) -> str:
    try:
        import qrcode
    except ImportError:
        return ""
    q = qrcode.QRCode(border=1, box_size=8)
    q.add_data(url)
    buf = io.BytesIO()
    q.make_image(fill_color="#0b1f3a", back_color="white").save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


CSS = """
@page { size: 1280px 720px; margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; font-family: 'Noto Sans KR', 'Noto Sans', 'DejaVu Sans', 'WenQuanYi Zen Hei', sans-serif; color: #10203a; }
.slide { width: 1280px; height: 720px; position: relative; overflow: hidden; page-break-after: always; background: #fff; padding: 56px 64px 40px; }
.slide:last-child { page-break-after: auto; }
.bar { position: absolute; left: 0; top: 0; width: 100%; height: 8px; background: linear-gradient(90deg, #1565c0, #00a389); }
.foot { position: absolute; left: 64px; right: 64px; bottom: 18px; display: flex; justify-content: space-between; font-size: 12px; color: #8a97ab; }
h1 { font-size: 40px; margin: 0 0 10px; color: #0b1f3a; letter-spacing: -.5px; }
h2 { font-size: 32px; margin: 0 0 6px; color: #0b1f3a; }
.lead { font-size: 18px; color: #4a5b78; margin: 0 0 24px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
.box { border: 1px solid #dfe6f1; border-radius: 14px; padding: 18px 20px; background: #f7f9fc; }
.box h4 { margin: 0 0 6px; font-size: 18px; color: #1565c0; }
.box p { margin: 0; font-size: 15px; line-height: 1.45; color: #2b3a55; }
table { width: 100%; border-collapse: collapse; font-size: 15px; }
th { text-align: left; background: #0b1f3a; color: #fff; padding: 10px 12px; font-weight: 600; }
td { padding: 10px 12px; border-bottom: 1px solid #e3e9f3; vertical-align: top; line-height: 1.35; }
tr:nth-child(even) td { background: #f7f9fc; }
.title { background: #0b1f3a; color: #fff; padding: 70px 80px; }
.title h1 { color: #fff; font-size: 54px; max-width: 900px; line-height: 1.12; }
.title .ev { color: #6fb6ff; font-size: 18px; margin-bottom: 26px; font-weight: 600; }
.title .sub { font-size: 21px; color: #c4d3ea; max-width: 860px; line-height: 1.45; }
.title .team { position: absolute; left: 80px; bottom: 60px; font-size: 18px; line-height: 1.8; color: #e7eef9; }
.title .team b { color: #6fb6ff; font-weight: 600; display: inline-block; min-width: 200px; }
.title .logo { position: absolute; right: 80px; top: 70px; width: 130px; height: 130px; border-radius: 28px; background: linear-gradient(135deg,#3fa7ff,#22d3a6); display: grid; place-items: center; font-size: 52px; font-weight: 800; color: #0b1f3a; }
.shot { display: grid; grid-template-columns: 820px 1fr; gap: 26px; align-items: start; }
.shot img { width: 820px; border-radius: 12px; border: 1px solid #d6dfec; box-shadow: 0 8px 30px rgba(11,31,58,.18); }
.shot ul { margin: 0; padding-left: 20px; font-size: 16px; line-height: 1.55; color: #2b3a55; }
.shot li { margin-bottom: 8px; }
.arch { display: grid; grid-template-columns: repeat(5, 1fr); gap: 14px; margin-top: 10px; }
.arch .col { border-radius: 14px; padding: 16px; color: #fff; min-height: 300px; position: relative; }
.arch .col h4 { margin: 0 0 12px; font-size: 17px; }
.arch .col div { background: rgba(255,255,255,.16); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; font-size: 14px; }
.arch .col:not(:last-child)::after { content: '→'; position: absolute; right: -14px; top: 45%; color: #0b1f3a; font-size: 22px; font-weight: 700; }
.stack { margin-top: 22px; font-size: 15px; color: #4a5b78; background: #f1f5fb; border-radius: 10px; padding: 12px 16px; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 20px; }
.kpi { background: #0b1f3a; color: #fff; border-radius: 14px; padding: 16px 18px; }
.kpi b { display: block; font-size: 34px; color: #4fd1b5; }
.kpi span { font-size: 14px; color: #c4d3ea; }
.money { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 12px; }
.money div { background: #e8f3ff; border-radius: 10px; padding: 10px 14px; }
.money b { display: block; font-size: 22px; color: #1565c0; }
.small { font-size: 12.5px; color: #66758f; line-height: 1.45; margin-top: 10px; }
.steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
.step { border-top: 6px solid #1565c0; background: #f7f9fc; border-radius: 12px; padding: 16px 18px; }
.step .ph { font-size: 14px; color: #1565c0; font-weight: 700; }
.step h4 { margin: 4px 0 10px; font-size: 20px; }
.step ul { margin: 0; padding-left: 18px; font-size: 15px; line-height: 1.55; }
.end { background: #0b1f3a; color: #fff; display: flex; align-items: center; justify-content: space-between; padding: 80px; }
.end h1 { color: #fff; font-size: 60px; }
.end .qr { background: #fff; padding: 14px; border-radius: 16px; text-align: center; color: #0b1f3a; font-size: 14px; }
.end .qr img { width: 220px; height: 220px; display: block; }
.goal { margin-top: 26px; background: #0b1f3a; color: #fff; border-radius: 14px; padding: 18px 22px; font-size: 19px; border-left: 8px solid #00a389; }
.flow { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 18px; }
.flow div { background: #e8f3ff; border-radius: 10px; padding: 10px 12px; font-size: 14px; color: #10203a; display: flex; gap: 10px; align-items: center; }
.flow b { background: #1565c0; color: #fff; border-radius: 50%; min-width: 26px; height: 26px; display: grid; place-items: center; font-size: 13px; }
.num { position: absolute; right: 64px; top: 30px; font-size: 13px; color: #9aa7bb; }
"""


def build(lang: str) -> str:
    t, team = T[lang], TEAM[lang]
    foot = f'<div class="foot"><span>{t["title"]}</span><span>Qostanai Industry Hackathon 2026 · {team["school"].split(" (")[0]}</span></div>'
    slides = []
    add = lambda body, cls="": slides.append(f'<section class="slide {cls}">{body}</section>')  # noqa: E731

    add(f'''<div class="logo">DT</div><div class="ev">{t["event"]}</div><h1>{t["title"]}</h1>
        <div class="sub">{t["subtitle"]}</div>
        <div class="team"><div><b>{t["school"]}</b> {team["school"]}</div><div><b>{t["captain"]}</b> {team["captain"]}</div>
        <div><b>{t["members"]}</b> {team["members"]}</div></div>''', "title")

    add(f'''<div class="bar"></div><h2>{t["p_title"]}</h2><p class="lead">{t["p_lead"]}</p>
        <div class="grid2">{"".join(f'<div class="box"><h4>{a}</h4><p>{b}</p></div>' for a, b in t["p_items"])}</div>
        <div class="goal">{t["p_goal"]}</div>{foot}''')

    add(f'''<div class="bar"></div><h2>{t["s_title"]}</h2><p class="lead">{t["s_lead"]}</p>
        <table><tr><th style="width:36%">{t["s_req"]}</th><th>{t["s_how"]}</th></tr>
        {"".join(f"<tr><td><b>{a}</b></td><td>{b}</td></tr>" for a, b in t["s_rows"])}</table>{foot}''')

    cols = [("a_src", "#5b6b86"), ("a_gw", "#1565c0"), ("a_core", "#0b1f3a"), ("a_ai", "#00a389"), ("a_ui", "#7b4fd1")]
    add(f'''<div class="bar"></div><h2>{t["a_title"]}</h2>
        <div class="arch">{"".join(f'<div class="col" style="background:{c}"><h4>{t[k]}</h4>' + "".join(f"<div>{i}</div>" for i in t[k + "_items"]) + "</div>" for k, c in cols)}</div>
        <div class="flow">{"".join(f"<div><b>{i + 1}</b>{x}</div>" for i, x in enumerate(t["a_flow"]))}</div>
        <div class="stack">{t["a_stack"]}</div>{foot}''')

    add(f'''<div class="bar"></div><h2>{t["d_title"]}</h2><p class="lead">{t["d_lead"]}</p>
        <div class="kpis">{"".join(f"<div class='kpi'><b>{fmt(a)}</b><span>{fmt(b)}</span></div>" for a, b in t["d_cards"])}</div>
        <div style="display:grid;grid-template-columns:1fr 520px;gap:22px">
          <ul style="margin:0;padding-left:20px;font-size:15px;line-height:1.5;color:#2b3a55">{"".join(f'<li style="margin-bottom:8px">{fmt(x)}</li>' for x in t["d_items"])}</ul>
          <img src="{img(f"data_{lang}.png")}" style="width:520px;border-radius:12px;border:1px solid #d6dfec;box-shadow:0 8px 30px rgba(11,31,58,.18)">
        </div>{foot}''')

    for key, shot in (("v1", "plant"), ("v2", "exec"), ("v3", "incidents")):
        add(f'''<div class="bar"></div><h2>{t[key + "_title"]}</h2><p class="lead"></p>
            <div class="shot"><img src="{img(f"{shot}_{lang}.png")}"><ul>{"".join(f"<li>{x}</li>" for x in t[key + "_text"])}</ul></div>{foot}''')

    add(f'''<div class="bar"></div><h2>{t["ai_title"]}</h2>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-top:16px">
          <div style="display:grid;gap:12px">{"".join(f'<div class="box"><h4>{a}</h4><p>{b}</p></div>' for a, b in t["ai_steps"])}</div>
          <div><img src="{img(f"ai_{lang}.png")}" style="width:100%;border-radius:12px;border:1px solid #d6dfec">
            <div class="box" style="margin-top:12px"><h4>{t["ai_metrics"]}</h4>
            {"".join(f'<div style="display:flex;justify-content:space-between;font-size:15px;padding:3px 0"><span>{a}</span><b>{fmt(b)}</b></div>' for a, b in t["ai_m"])}</div>
            <div class="small">{t["ai_note"]}</div></div></div>{foot}''')

    h = t["sc_h"]
    add(f'''<div class="bar"></div><h2>{t["sc_title"]}</h2><p class="lead"></p>
        <table><tr><th style="width:22%">{h[0]}</th><th>{h[1]}</th><th style="width:34%">{h[2]}</th></tr>
        {"".join(f"<tr><td><b>{a}</b></td><td>{b}</td><td>{c}</td></tr>" for a, b, c in t["sc_rows"])}</table>{foot}''')

    add(f'''<div class="bar"></div><h2>{t["e_title"]}</h2><p class="lead">{fmt(t["e_lead"])}</p>
        <div class="kpis">{"".join(f"<div class='kpi'><b>{fmt(a)}</b><span>{b}</span></div>" for a, b in t["e_kpis"])}</div>
        <div style="display:grid;grid-template-columns:1.1fr 1fr;gap:22px">
          <table><tr><th></th><th>{t["e_reactive"]}</th><th>{t["e_predictive"]}</th></tr>
          {"".join(f"<tr><td>{a}</td><td>{fmt(b)}</td><td><b>{fmt(c)}</b></td></tr>" for a, b, c in t["e_rows"])}</table>
          <div><b style="font-size:17px">{t["e_money"]}</b>
            <div class="money">{"".join(f"<div><b>{fmt(a)}</b>{b}</div>" for a, b in t["e_money_items"])}</div>
            <div class="small">{fmt(t["e_assump"])}</div><div class="small"><b>{fmt(t["e_cons"])}</b></div><div class="small">{t["e_soft"]}</div></div>
        </div>{foot}''')

    add(f'''<div class="bar"></div><h2>{t["r_title"]}</h2><p class="lead"></p>
        <div class="steps">{"".join(f'<div class="step"><div class="ph">{a}</div><h4>{b}</h4><ul>' + "".join(f"<li>{x}</li>" for x in c) + "</ul></div>" for a, b, c in t["r_steps"])}</div>
        <div class="stack">{t["r_risks"]}</div>{foot}''')

    add(f'''<div class="bar"></div><h2>{t["w_title"]}</h2><p class="lead"></p>
        <div class="grid3">{"".join(f'<div class="box"><h4>{a}</h4><p>{b}</p></div>' for a, b in t["w_items"])}</div>{foot}''')

    add(f'''<div><h1>{t["end_title"]}</h1><div style="font-size:24px;color:#c4d3ea">{t["end_sub"]}</div>
        <div style="margin-top:40px;font-size:18px;line-height:1.8;color:#e7eef9"><div><b style="color:#6fb6ff">{t["repo"]}:</b> {_html.escape(REPO)}</div><div>{t["run"]}</div>
        <div style="margin-top:20px">{team["captain"]} · {team["members"]}</div></div></div>
        <div class="qr"><img src="{qr_data(REPO)}">{t["repo"]}</div>''', "end")

    for i in range(1, len(slides) - 1):
        slides[i] = slides[i].replace("</section>", f'<div class="num">{i + 1} / {len(slides)}</div></section>')
    return f'<!doctype html><html lang="{lang}"><head><meta charset="utf-8"><style>{CSS}</style></head><body>{"".join(slides)}</body></html>'


def main():
    OUT.mkdir(exist_ok=True)
    for lang in ("ru", "ko"):
        html = OUT / f"slides_{lang}.html"
        html.write_text(build(lang), encoding="utf-8")
    subprocess.run(["node", str(HERE / "render_pdf.js"), str(OUT)], check=True)


if __name__ == "__main__":
    main()
