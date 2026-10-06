/* ============================================================================
   liquid-glass-nav.js — Liquid Glass навбар для любого HTML (WebGPU/HDR, запасной путь WebGL).

   ПОДКЛЮЧЕНИЕ (ES-модуль; страницу нужно открывать через http(s)://, а не file://):

     <nav id="nav" class="tabs">
       <button aria-current="page"><svg viewBox="0 0 24 24">…</svg>Главная</button>
       <button><svg viewBox="0 0 24 24">…</svg>Поиск</button>
       …любое число вкладок одинаковой ширины…
     </nav>
     <script type="module">
       import {createLiquidGlassNav} from './liquid-glass-nav.js';
       const glass=createLiquidGlassNav(document.getElementById('nav'),{ background:'#bg' });
       document.getElementById('nav').addEventListener('lg-change',e=>console.log(e.detail.index));
     </script>

   Без сервера (file://) подключайте классическую версию: <script src="liquid-glass-nav.iife.js"></script>
   → window.LiquidGlassNav.create(nav, options).

   КОНТЕНТ берётся из самого HTML: у каждого дочернего элемента nav (кнопка/ссылка) модуль читает <svg>/<img> и текст,
   их реальное положение и шрифт, и рисует их внутрь стекла (белым и голубым). Меняете HTML (добавили вкладку, сменили иконку
   или текст) — модуль заметит сам (MutationObserver). Активная вкладка — та, у которой aria-current.

   ТРЕБОВАНИЯ К nav: заданные ширина и высота в CSS, вкладки равной ширины (grid 1fr / flex:1). Скругление и фон задавать не нужно.
   Стили svg лучше задавать на самом <svg> (fill/stroke/stroke-width…) — правила на вложенные path читаются через computed style.

   ПАРАМЕТРЫ — объект DEFAULTS ниже; любой можно переопределить вторым аргументом createLiquidGlassNav(nav,{…}).
   Возвращает {ready, index, select(i), refresh(), destroy(), canvas}.
   ============================================================================ */
/* ======================================================================
   CONFIG — все параметры ползунка и бара. Правятся только здесь.
   Размеры — в CSS-пикселях. Шейдерные значения подставляются при запуске
   (после правки — перезагрузить страницу).
   Конвейер (по слоям Liquid Glass):
     1. Scene   — сцена под стеклом рендерится в текстуру
     2. Blur    — цепочка downsample ×2 → ×4 → ×8 (dual-Kawase), это «матовость» стекла
     3. Refract — SDF → высота → нормаль → закон Снеллиуса (refract), смещает выборку сцены
     4. Disperse— веер из 3 выборок: R и B смещены в разные стороны от опорного G
     5. Tint/Vibrancy → 6. Specular (Блинн-Фонг) + Френель → экран
   ====================================================================== */
export const DEFAULTS={
  // ---- Форма ползунка ----
  lensGap:4,            // зазор между краем ползунка и границей ячейки
  lensInsetY:4,         // отступ верха/низа ползунка от краёв бара
  pressGrowX:11,        // раздувание по ширине при нажатии, px
  pressGrowY:7,        // раздувание по высоте при нажатии, px (ползунок может выходить за бар)
  stretchBySpeed:.007,  // сжатие по высоте от скорости (0 — выкл.)
  stretchMax:10,         // максимум сжатия, px
  stretchSmooth:7,     // быстрота сглаживания сжатия

  // ---- Слой 2: преломление (геометрия стекла) ----
  thickness:12,         // максимальная «высота» стекла в центре, px: больше → сильнее сдвиг фона
  // Ширина фаски (зоны преломления у края) РАЗНАЯ: по бокам (скруглённые торцы) и сверху/снизу (плоские края).
  // Между ними переход плавный: ширина зависит от направления нормали к краю (на торце — боковая, на «плечах» — смесь, на плоскости — верх/низ).
  bevelWidthX:24,       // ширина фаски слева и справа, px
  bevelWidthY:3,        // ширина фаски сверху и снизу, px
  bevelBlendPow:1,      // резкость перехода: 1 — плавный (по cos² угла), больше — боковая фаска остаётся только у самой оси X, меньше 1 — боковая шире захватывает «плечи»
  slopeMax:4,           // ограничитель крутизны фаски (у самого края наклон стремится к ∞)
  edgeHeight:1,        // 0 — высота стекла падает к нулю у края (слабый сдвиг), 1 — постоянная (сильный сдвиг у самого края, как у Apple)
  idleRefract:.1,       // доля преломления, когда ползунка НЕ касаются (0 — плоский, без преломления)
  ior:1.7,             // показатель преломления (стекло ≈1.5): больше → сильнее изгиб
  refractSign:1.5,        // для ИКОНОК и ПОДПИСЕЙ: 1 — вогнутая линза (у края расходятся от центра, растягиваются), -1 — выпуклая
  magnify:1,          // увеличение центра: <1 увеличивает, 1 — без увеличения
  magnifyPress:.03,     // добавочное увеличение при нажатии

  // ---- Слой 3: хроматическая аберрация — «веер» из 3 выборок (как ChromaticAberration в shaders.com + радиальный масштаб из three.js) ----
  // Каждый канал берётся ОДНОЙ выборкой со своим смещением; зелёный (множитель 0) — опорный и не двигается.
  // Аберрация работает ТОЛЬКО при касании (плавно нарастает вместе с нажатием) и только у края: в середине её нет.
  // Вместо трёх выборок — спектральный веер из 7: фон у края распадается на непрерывную радугу.
  caSpread:1.2,         // разброс цветов: красный сдвигается на (1−spread)·D, синий на (1+spread)·D, где D — тот же вектор преломления → копии расходятся ВМЕСТЕ с преломлением (0 — нет аберрации)
  caPow:1,              // как быстро аберрация нарастает к краю (1 — вместе с преломлением, больше — только у самой кромки)
  caDirection:'radial', // 'radial' — вдоль нормали к краю ползунка (от центра наружу); 'angle' — один фиксированный угол
  caAngle:0,            // угол в градусах для режима 'angle' (0 — вправо, 90 — вниз)
  caContent:.8,         // доля аберрации для иконок/текста (0 — буквы без цветных краёв)

  // ---- Иконки и подписи в ползунке (преломляются слабее фона, чтобы читались) ----
  contentMagnify:0.92,  // увеличение иконок/текста (1 — нет)
  contentBend:.55,       // доля сдвига фона, применяемая к тексту (0 — текст не искажается)

  // ---- Слой 2: размытие (матовость) ----
  frost:1.0,            // радиус размытия: множитель шага последнего up-сэмпла (больше — мягче)
  lensBlur:1,         // доля размытого фона внутри ползунка (0 — кристально чисто, 1 — как бар), по умолчанию .05

  // ---- Ползунок В ПОКОЕ (пока его не трогают): тёмная плоская плашка, не линза ----
  // Иконка под ним — чистая голубая, без преломления и фильтров. При касании плавно превращается в прозрачную линзу.
  idleDarken:.6,        // насколько плашка темнее бара (0 — цвет бара, 1 — цвет idleTint)
  idleTint:[.02,.02,.03], // цвет «дна» плашки в покое
  lensOnStart:0,        // при каком нажатии (0..1) начинает появляться линза
  lensOnEnd:.6,         // при каком нажатии линза включена полностью

  // ---- При касании: подсветка и «резиновый» бар ----
  barGlow:.06,          // насколько светлеет бар при касании (свечение), добавка к яркости
  iconGlow:.45,         // подсветка иконок/подписей при касании (доля яркости); голубая иконка под ползунком светится вместе с баром
  hdrGlowGain:.6,       // во сколько раз сильнее свечение на HDR-экране (доля HDR-запаса)
  iconActiveAlpha:.72,  // прозрачность голубой иконки под линзой при касании (1 — непрозрачная)
  barPressScale:.045,   // на сколько бар увеличивается при касании (0.035 = +3.5%)
  barRubberByVelocity:0, // «резиновость»: растяжение бара на каждый px/с скорости ползунка (0 — выкл.)
  barRubberMax:.06,     // максимум растяжения по ширине (доля)
  barRubberSquash:.7,   // во сколько раз бар сплющивается по высоте относительно растяжения (1 — сохраняет площадь)
  barFollow:5,          // px: бар чуть тянется за положением ползунка (к краю, где он находится)
  barLean:4,            // px: дополнительный наклон бара по направлению движения
  barLeanSpeed:1500,    // скорость (px/с), при которой наклон достигает barLean
  barRubberStiffness:120, // жёсткость «резинки» (больше — быстрее возвращается)
  barRubberDamping:.4,  // демпфирование «резинки»: меньше — больше покачивания, 1 — без отскока

  // ---- Слой 4: Tint & Vibrancy ----
  barTint:.5,           // насколько бар затемнён оттенком (0 — прозрачный, 1 — глухой)
  barTintColor:[.10,.105,.12], // цвет оттенка бара
  barVibrancy:1.3,      // насыщенность фона под баром (1 — как есть)
  barContrast:1.0,      // контраст вокруг серого (1 — как есть)
  lensSeesBar:.2,       // сколько оттенка/матовости бара видно сквозь ползунок в покое (0 — только чистый фон)
  lensSeesBarPress:.9,  // то же при касании: сквозь ползунок виден сам бар вместе с его кромкой, и она преломляется
  lensVibrancy:1.2,     // насыщенность внутри ползунка
  lensContrast:1.02,    // контраст внутри ползунка
  lensBrightness:1.05,  // множитель яркости ползунка
  lensLift:.02,         // подъём чёрного ползунка

  // ---- Слой 5: блики (Блинн-Фонг + Френель) ----
  lightDir:[-.7,-.75],  // направление света сверху-слева (x, y; y вниз)
  lightZ:.6,            // высота источника над стеклом (меньше — блики ближе к краю)
  shininess:48,         // острота блика (больше — тоньше)
  specular:0,         // яркость блика основного света
  fillLight:0,         // яркость встречного света (блик с противоположной стороны), доля от основного
  fresnelF0:.04,        // отражение при взгляде в упор (стекло ≈ .04)
  fresnelPower:9,       // степень Френеля: больше — сияние только у самого края
  fresnelGain:0.42,     // мягкая кайма у края (только при касании)
  edgeAbsorb:.4,        // затемнение у самого края при касании (тёмная «рамка» от толщи стекла)
  rimLine:0,           // тонкая светлая линия по самому краю (0 — убрать)
  rimWidth:1.2,         // её толщина, px

  // ---- Тень ползунка на баре ----
  // lensShadow:.28, lensShadowPress:.18, lensShadowSpread:10,
  lensShadow:0, lensShadowPress:0, lensShadowSpread:10,

  // ---- Бар ----
  barInset:5,           // буфер у краёв бара: сквозь ползунок не просвечивает кромка бара
  // Фон и кромки бара под ползунком + сам бар как линза (у его краёв сдвиг, размытие, аберрация):
  barBend:.5,            // как фон и кромки бара преломляются в ползунке: 1 — так же, как иконки (вогнутая линза), 0 — не преломляются, отрицательное — выпуклая
  barBevel:14,          // ширина зоны у краёв бара, где он работает как линза, px
  barPhantomInset:4,    // «фантомный» узкий бар: при касании кромка бара внутри ползунка рисуется на столько px глубже реальной (иначе вогнутая линза берёт содержимое только изнутри и кромка недостижима); 0 — выкл.
  barEdgeShift:7,       // сдвиг фона у самого края бара, px (содержимое снаружи втягивается внутрь)
  barEdgeCA:.9,         // аберрация на краях бара (0 — нет)
  barEdgeBlur:1.5,      // во сколько раз сильнее размытие у самого края бара
  barRim:.08, barRimGain:.30, barRimShade:.22, barRimWidth:1.2, // свето-теневая кромка бара: свет сверху-слева, тень снизу-справа
  // barShadow:.30, barShadowDy:5, barShadowSpread:9, // тень бара
  barShadow:0, barShadowDy:0, barShadowSpread:9, // тень бара

  // ---- HDR (WebGPU + HDR-экран; иначе тихо выключается) ----
  hdrPeak:3.2,          // во сколько раз блики могут быть ярче SDR-белого
  hdrSpecGain:1.1,      // доля HDR-усиления для бликов ползунка
  hdrBarRimGain:.4,     // то же для блика бара
  hdrIconGain:.6,       // HDR-усиление активной синей иконки

  // ---- Иконки (рисуются в текстуру) ----
  iconWhite:'rgba(255,255,255,.94)', iconBlue:'#4ec9b0', iconStroke:1.8, iconStrokeActive:2,

  // ---- Физика (пружины) ----
  physicsHz:120,        // частота подшагов физики
  stiffness:440,        // базовая жёсткость краёв
  leadBoost:12000,        // доп. жёсткость переднего края при движении
  lagPenalty:-540,       // мягкость заднего края («тянущаяся капля»)
  damping:.7,           // демпфирование краёв: 1 — без отскока
  pressStiffness:660, pressDamping:.64, // пружина нажатия
  pressHold:150,        // минимум мс удержания «нажатого» состояния
  tapSpeed:.3,          // скорость ползунка при простом ТАПЕ по вкладке (не перетаскивании): 1 — как при перетаскивании, меньше — медленнее (.4 ≈ в 2.5 раза медленнее)
  tapMoveSlop:6,        // сдвиг пальца, px: пока он меньше — это тап (скорость tapSpeed), больше — перетаскивание (обычная скорость)
  tapHoldPress:true,    // при тапе держать «нажатое» стекло (линзу) до тех пор, пока ползунок не доедет до вкладки (false — отпускать через pressHold мс, как раньше)

  // ---- Рендер ----
  maxDpr:9,             // потолок плотности пикселей бара
  bgMaxScale:1.5,       // разрешение фона страницы
  pad:56,                // запас канваса вокруг бара под тени и выход ползунка за границы,
  // ---- Модуль: фон под стеклом, события, поведение ----
  // Стекло преломляет не DOM страницы (браузер не даёт его прочитать в WebGL), а «сцену», которую вы ему передаёте:
  background:null,      // что лежит ПОД баром: элемент <canvas>/<img>/<video> (или CSS-селектор такого элемента), либо функция (ctx,info)=>{...},
                        // рисующая в 2D-канвас в координатах страницы (info: {time,dpr,x,y,width,height}). null — сплошной цвет backgroundColor.
  backgroundColor:'auto', // сплошной цвет под баром, если фона нет; 'auto' — берётся фон <body>/<html> (или тёмный #0b0c12)
  liveBackground:true,  // перерисовывать сцену каждый кадр (нужно для анимированного фона/видео); false — только при ресайзе и nav.refresh()
  clickOnSelect:true,   // при смене вкладки ползунком/стрелками вызывать .click() на её элементе (чтобы работали ваши обработчики и <a href>)
  onChange:null,        // (index, item)=>{} — вызывается при смене вкладки; то же приходит событием 'lg-change' на nav
};

export function createLiquidGlassNav(nav,options={}){
const C=Object.assign({},DEFAULTS,options),f=x=>Number.isInteger(x)?x+'.':String(x),L=C.lightDir,TC=C.barTintColor;
const v3=a=>`vec3(${f(a[0])},${f(a[1])},${f(a[2])})`;
const HG_G=`(1.+(E.w-1.)*${f(C.hdrGlowGain)})`,HG_W=`(1.+(u.e.w-1.)*${f(C.hdrGlowGain)})`;
const BGLOW_G=`${f(C.barGlow)}*clamp(C.w,0.,1.)*${HG_G}`,BGLOW_W=`${f(C.barGlow)}*clamp(u.c.w,0.,1.)*${HG_W}`;   // свечение бара
const IGLOW_G=`${f(C.iconGlow)}*clamp(C.w,0.,1.)*${HG_G}`,IGLOW_W=`${f(C.iconGlow)}*clamp(u.c.w,0.,1.)*${HG_W}`; // свечение иконок
const CAA=C.caAngle*Math.PI/180,r4=x=>Number(x.toFixed(4));
const CADIR=C.caDirection==='angle'?`vec2(${f(r4(Math.cos(CAA)))},${f(r4(Math.sin(CAA)))})`:'ln'; // направление веера
const CAD_W=CADIR.replace(/vec2\(/,'vec2f(');


const SDB_G='float sdb(vec2 p,vec2 h,float r){vec2 q=abs(p)-h+r;return min(max(q.x,q.y),0.)+length(max(q,0.))-r;}';
const VS='attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
const WG_COMMON=`struct Ub{a:vec4f,b:vec4f,c:vec4f,e:vec4f,g:vec4f};
@group(0)@binding(0) var<uniform> u:Ub;
fn sdb(p:vec2f,h:vec2f,r:f32)->f32{let q=abs(p)-h+r;return min(max(q.x,q.y),0.)+length(max(q,vec2f(0.)))-r;}
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{let x=f32((i<<1u)&2u);let y=f32(i&2u);return vec4f(x*2.-1.,1.-y*2.,0.,1.);}`;
const FSDOWN=`precision highp float;uniform sampler2D uSrc;uniform vec4 D;
void main(){vec2 u=gl_FragCoord.xy*D.xy,o=D.zw;
gl_FragColor=vec4((texture2D(uSrc,u).rgb*4.+texture2D(uSrc,u+o).rgb+texture2D(uSrc,u-o).rgb+texture2D(uSrc,u+vec2(o.x,-o.y)).rgb+texture2D(uSrc,u+vec2(-o.x,o.y)).rgb)/8.,1.);}`;

/* ==== PASS 3–6: композит бара и ползунка (GLSL, WebGL/SDR) ====
   A=(w,h,origin) B=бар(x,y,w,h) C=(xl,xr,hh,press) E=(T,PH,dpr,HDR) G=(1/Zw,1/Zh)
   uC — иконки, uS — сцена, uZ — самый размытый уровень */
const FSBAR=`precision highp float;uniform vec4 A,B,C,E,G;uniform sampler2D uC,uS,uZ;
${SDB_G}
const vec2 LD=vec2(${f(L[0])},${f(L[1])});const vec3 V=vec3(0.,0.,1.);
float sdBar(vec2 l){return sdb(l-B.xy-B.zw*.5,B.zw*.5,B.w*.5);}
vec2 nBar(vec2 l){return normalize(vec2(sdBar(l+vec2(.5,0.))-sdBar(l-vec2(.5,0.)),sdBar(l+vec2(0.,.5))-sdBar(l-vec2(0.,.5)))+1e-5);}
float rimAt(vec2 l,float ins){float d=sdBar(l)+ins,dp=max(-d,0.),k=dot(nBar(l),normalize(LD)); // свето-теневая кромка бара: + свет, − тень
  return (1.-smoothstep(0.,${f(C.barRimWidth)},dp))*(${f(C.barRim)}+${f(C.barRimGain)}*max(k,0.)-${f(C.barRimShade)}*max(-k,0.))*(1.+(E.w-1.)*${f(C.hdrBarRimGain)});}
vec2 tuv(vec2 l){return vec2(l.x,A.y-l.y)/A.xy;}                 // FBO в WebGL перевёрнут по Y
vec3 T0(vec2 l){return texture2D(uS,tuv(l)).rgb;}                // чёткая сцена
vec3 ZBk(vec2 l,float kb){vec2 u=tuv(l),o=G.xy*${f(C.frost)}*kb;              // размытая сцена (Kawase up, 5 выборок)
  return (texture2D(uZ,u).rgb*4.+texture2D(uZ,u+o).rgb+texture2D(uZ,u-o).rgb+texture2D(uZ,u+vec2(o.x,-o.y)).rgb+texture2D(uZ,u+vec2(-o.x,o.y)).rgb)/8.;}
vec3 ZB(vec2 l){return ZBk(l,1.);}
vec3 vib(vec3 c,float s,float k){float y=dot(c,vec3(.2126,.7152,.0722));return (mix(vec3(y),c,s)-.5)*k+.5;} // Vibrancy + контраст
vec3 barBg(vec2 l){ // фон под баром: сам бар — тоже линза; у краёв выпуклый сдвиг, нарастающее размытие и аберрация
  float d=sdBar(l),ub=1.-clamp(max(-d,0.)/${f(C.barBevel)},0.,1.),e=ub*ub*ub;
  if(e<.01)return ZB(l);
  vec2 n=nBar(l);vec3 sum=vec3(0.),ws=vec3(0.);float kb=1.+${f(C.barEdgeBlur)}*e;
  for(int i=0;i<5;i++){float t=float(i)/4.,m=t*2.-1.;
    vec3 w=vec3(clamp(1.-t*1.4,0.,1.),clamp(1.-abs(t-.5)*2.,0.,1.),clamp(t*1.4-.4,0.,1.));
    sum+=ZBk(l+n*${f(C.barEdgeShift)}*e*(1.+${f(C.barEdgeCA)}*m),kb)*w;ws+=w;}
  return sum/ws;}
vec3 barBody(vec2 l){return vib(mix(barBg(l),${v3(TC)},${f(C.barTint)}),${f(C.barVibrancy)},${f(C.barContrast)})+.03+${BGLOW_G};}
vec3 lensBack(vec2 l0){ // что лежит под ползунком. В покое — кромка бара скрыта (точка прижата внутрь); при касании — виден сам бар: тон, кромка, тень
  float act=clamp(C.w,0.,1.);vec2 l=l0;float d0=sdBar(l);
  if(d0>-${f(C.barInset)})l-=nBar(l)*(d0+${f(C.barInset)})*(1.-act);
  float ins=${f(C.barPhantomInset)}*act,d=sdBar(l)+ins,cv=1.-smoothstep(-1.,1.,d);
  vec3 fr=ZB(l),sc=vib(mix(T0(l),fr,${f(C.lensBlur)}),${f(C.lensVibrancy)},${f(C.lensContrast)});
  vec3 body=vib(mix(fr,${v3(TC)},${f(C.barTint)}),${f(C.barVibrancy)},${f(C.barContrast)})+.03+${BGLOW_G};
  vec3 inside=mix(sc,body,mix(${f(C.lensSeesBar)},${f(C.lensSeesBarPress)},act))+rimAt(l,ins);
  vec3 outside=sc*(1.-${f(C.barShadow)}*exp(-max(sdBar(l-vec2(0.,${f(C.barShadowDy)}))+ins,0.)/${f(C.barShadowSpread)}));
  return mix(outside,inside,cv);}
vec4 cont(vec2 lt,float blue){vec2 uv=(lt-B.xy)/B.zw;return texture2D(uC,vec2(uv.x,uv.y*.5+blue*.5));}
vec3 tap(vec2 pos,vec2 cpos){vec4 k=cont(cpos,1.)*mix(1.,${f(C.iconActiveAlpha)},clamp(C.w,0.,1.));return lensBack(pos)*(1.-k.a)+k.rgb*(1.+${f(C.hdrIconGain)}*(E.w-1.)+${IGLOW_G});} // одна выборка: фон + синяя иконка (под линзой слегка прозрачная и светится)
void main(){
  float dpr=E.z,aa=1./dpr;vec2 l=vec2(gl_FragCoord.x,A.y*dpr-gl_FragCoord.y)/dpr;
  float d=sdBar(l),cov=1.-smoothstep(-aa,aa,d);
  float shA=${f(C.barShadow)}*exp(-max(sdBar(l-vec2(0.,${f(C.barShadowDy)})),0.)/${f(C.barShadowSpread)});
  vec2 lc=vec2(B.x+(C.x+C.y)*.5,B.y+B.w*.5),hw=vec2((C.y-C.x)*.5,C.z);float r=min(hw.x,hw.y);
  vec2 lp=l-lc;float dl=sdb(lp,hw,r);
  if(cov<=0.&&dl>2.){gl_FragColor=vec4(0.,0.,0.,shA);return;}
  vec3 c=vec3(0.),bodyC=vec3(0.);
  if(cov>0.){ // --- тело бара: матовое стекло + иконки (при касании светятся) ---
    bodyC=barBody(l);vec4 k=cont(l,0.);c=bodyC*(1.-k.a)+k.rgb*(1.+${IGLOW_G});
    c+=rimAt(l,0.);
    c*=1.-(${f(C.lensShadow)}+${f(C.lensShadowPress)}*C.w)*exp(-max(dl,0.)/${f(C.lensShadowSpread)});}
  float lensCov=1.-smoothstep(-aa,aa,dl);vec3 lcol=vec3(0.);
  if(dl<2.){ // --- ползунок (рисуется поверх бара со своей маской) ---
    float act=clamp(C.w,0.,1.);                                      // 0 — не касаются, 1 — нажат/тащим
    float wA=smoothstep(${f(C.lensOnStart)},${f(C.lensOnEnd)},act);  // доля «линзы» (0 — плоская тёмная плашка)
    vec4 ki=cont(l,1.);                                              // чистая голубая иконка на своём месте
    lcol=mix(bodyC,${v3(C.idleTint)},${f(C.idleDarken)});            // плашка в покое — темнее бара, без преломления
    lcol=lcol*(1.-ki.a)+ki.rgb*(1.+${f(C.hdrIconGain)}*(E.w-1.));
    if(wA>.001){
    vec2 ln=normalize(vec2(sdb(lp+vec2(1.,0.),hw,r)-sdb(lp-vec2(1.,0.),hw,r),sdb(lp+vec2(0.,1.),hw,r)-sdb(lp-vec2(0.,1.),hw,r))+1e-5);
    float bw=mix(${f(C.bevelWidthY)},${f(C.bevelWidthX)},pow(ln.x*ln.x,${f(C.bevelBlendPow)})); // ширина фаски: по бокам X, сверху/снизу Y, между ними плавно
    float dp=max(-dl,0.),u1=1.-clamp(dp/bw,0.,1.);                   // u1: 0 — середина, 1 — самый край
    float q=sqrt(max(1.-u1*u1,0.));                                  // профиль фаски — четверть окружности
    float hgt=${f(C.thickness)}*mix(q,1.,${f(C.edgeHeight)});        // высота стекла (у края не падает до нуля → сильный сдвиг)
    float slope=min(${f(C.thickness)}*u1/(bw*max(q,.02)),${f(C.slopeMax)});
    vec3 N=normalize(vec3(ln*slope,1.));                             // нормаль: в центре (0,0,1) → сдвига нет
    vec2 base=lc+lp*mix(1.,${f(C.magnify)}-${f(C.magnifyPress)},act),cb=lc+lp*mix(1.,${f(C.contentMagnify)},act);
    vec3 R0=refract(vec3(0.,0.,-1.),N,1./${f(C.ior)});
    float rk=mix(${f(C.idleRefract)},1.,act);
    vec2 Dr=R0.xy/max(-R0.z,.25)*hgt;                                // «сырой» сдвиг: из глубины к краю
    vec2 D=Dr*${f(C.refractSign)}*act;                               // иконки и подписи: вогнутая линза, только при касании
    vec2 Db=Dr*${f(C.barBend)}*rk;                                   // фон и кромки бара
    vec2 P0=base+Db, C0=cb+D*${f(C.contentBend)};
    float wCA=pow(u1,${f(C.caPow)})*act*${f(C.caSpread)};            // аберрация: только при касании, только у края
    vec3 acc;
    if(wCA<.002){acc=tap(P0,C0);}
    else{ // спектральный веер: 7 выборок вдоль ТОГО ЖЕ вектора D (красный — короче, синий — длиннее)
      vec3 sum=vec3(0.),ws=vec3(0.);
      for(int i=0;i<7;i++){float t=float(i)/6.,m=t*2.-1.;
        vec3 w=vec3(clamp(1.-t*1.4,0.,1.),clamp(1.-abs(t-.5)*2.,0.,1.),clamp(t*1.4-.4,0.,1.));
        sum+=tap(base+Db*(1.+wCA*m),cb+D*${f(C.contentBend)}*(1.+wCA*m*${f(C.caContent)}))*w;ws+=w;}
      acc=sum/ws;}
    vec3 lensCol=acc*${f(C.lensBrightness)}+${f(C.lensLift)};
    lensCol*=1.-${f(C.edgeAbsorb)}*act*pow(u1,6.);                   // тёмная «рамка» из-за толщи стекла у самого края
    float gS=1.+(E.w-1.)*${f(C.hdrSpecGain)};
    vec3 L1=normalize(vec3(LD,${f(C.lightZ)})),L2=normalize(vec3(-LD,${f(C.lightZ)}));
    float sp=pow(max(dot(N,normalize(L1+V)),0.),${f(C.shininess)})+${f(C.fillLight)}*pow(max(dot(N,normalize(L2+V)),0.),${f(C.shininess)}); // Блинн-Фонг
    float fr=${f(C.fresnelF0)}+(1.-${f(C.fresnelF0)})*pow(1.-N.z,${f(C.fresnelPower)});                                                        // Френель
    lensCol+=(sp*${f(C.specular)}+(fr*${f(C.fresnelGain)}+(1.-smoothstep(0.,${f(C.rimWidth)},dp))*${f(C.rimLine)})*act)*gS;
    lcol=mix(lcol,lensCol,wA);}}
  gl_FragColor=vec4(c*cov*(1.-lensCov)+lcol*lensCov,lensCov+(1.-lensCov)*(cov+(1.-cov)*shA));}`;


const WG_DOWN=`@group(0)@binding(0) var<uniform> d:vec4f;@group(0)@binding(1) var smp:sampler;@group(0)@binding(2) var src:texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{let x=f32((i<<1u)&2u);let y=f32(i&2u);return vec4f(x*2.-1.,1.-y*2.,0.,1.);}
fn s(u:vec2f)->vec3f{return textureSampleLevel(src,smp,u,0.).rgb;}
@fragment fn fs(@builtin(position) fc:vec4f)->@location(0) vec4f{let u=fc.xy*d.xy;let o=d.zw;
return vec4f((s(u)*4.+s(u+o)+s(u-o)+s(u+vec2f(o.x,-o.y))+s(u+vec2f(-o.x,o.y)))/8.,1.);}`;

const WG_BAR=`${WG_COMMON}
@group(0)@binding(1) var smp:sampler;@group(0)@binding(2) var tC:texture_2d<f32>;@group(0)@binding(3) var tS:texture_2d<f32>;@group(0)@binding(4) var tZ:texture_2d<f32>;
const LD=vec2f(${f(L[0])},${f(L[1])});const V=vec3f(0.,0.,1.);
fn sdBar(l:vec2f)->f32{return sdb(l-u.b.xy-u.b.zw*.5,u.b.zw*.5,u.b.w*.5);}
fn nBar(l:vec2f)->vec2f{return normalize(vec2f(sdBar(l+vec2f(.5,0.))-sdBar(l-vec2f(.5,0.)),sdBar(l+vec2f(0.,.5))-sdBar(l-vec2f(0.,.5)))+1e-5);}
fn rimAt(l:vec2f,ins:f32)->f32{let d=sdBar(l)+ins;let dp=max(-d,0.);let k=dot(nBar(l),normalize(LD));
  return (1.-smoothstep(0.,${f(C.barRimWidth)},dp))*(${f(C.barRim)}+${f(C.barRimGain)}*max(k,0.)-${f(C.barRimShade)}*max(-k,0.))*(1.+(u.e.w-1.)*${f(C.hdrBarRimGain)});}
fn T0(l:vec2f)->vec3f{return textureSampleLevel(tS,smp,l/u.a.xy,0.).rgb;}
fn zs(p:vec2f)->vec3f{return textureSampleLevel(tZ,smp,p,0.).rgb;}
fn ZBk(l:vec2f,kb:f32)->vec3f{let p=l/u.a.xy;let o=u.g.xy*${f(C.frost)}*kb;
  return (zs(p)*4.+zs(p+o)+zs(p-o)+zs(p+vec2f(o.x,-o.y))+zs(p+vec2f(-o.x,o.y)))/8.;}
fn ZB(l:vec2f)->vec3f{return ZBk(l,1.);}
fn vib(c:vec3f,s:f32,k:f32)->vec3f{let y=dot(c,vec3f(.2126,.7152,.0722));return (mix(vec3f(y),c,s)-.5)*k+.5;}
fn barBg(l:vec2f)->vec3f{
  let d=sdBar(l);let ub=1.-clamp(max(-d,0.)/${f(C.barBevel)},0.,1.);let e=ub*ub*ub;
  if(e<.01){return ZB(l);}
  let n=nBar(l);var sum=vec3f(0.);var ws=vec3f(0.);let kb=1.+${f(C.barEdgeBlur)}*e;
  for(var i=0;i<5;i++){let t=f32(i)/4.;let m=t*2.-1.;
    let w=vec3f(clamp(1.-t*1.4,0.,1.),clamp(1.-abs(t-.5)*2.,0.,1.),clamp(t*1.4-.4,0.,1.));
    sum+=ZBk(l+n*${f(C.barEdgeShift)}*e*(1.+${f(C.barEdgeCA)}*m),kb)*w;ws+=w;}
  return sum/ws;}
fn barBody(l:vec2f)->vec3f{return vib(mix(barBg(l),${v3(TC).replace(/vec3\(/,'vec3f(')},${f(C.barTint)}),${f(C.barVibrancy)},${f(C.barContrast)})+.03+${BGLOW_W};}
fn lensBack(l0:vec2f)->vec3f{
  let act=clamp(u.c.w,0.,1.);var l=l0;let d0=sdBar(l);
  if(d0>-${f(C.barInset)}){l-=nBar(l)*(d0+${f(C.barInset)})*(1.-act);}
  let ins=${f(C.barPhantomInset)}*act;let d=sdBar(l)+ins;let cv=1.-smoothstep(-1.,1.,d);
  let fr=ZB(l);let sc=vib(mix(T0(l),fr,${f(C.lensBlur)}),${f(C.lensVibrancy)},${f(C.lensContrast)});
  let body=vib(mix(fr,${v3(TC).replace(/vec3\(/,'vec3f(')},${f(C.barTint)}),${f(C.barVibrancy)},${f(C.barContrast)})+.03+${BGLOW_W};
  let inside=mix(sc,body,mix(${f(C.lensSeesBar)},${f(C.lensSeesBarPress)},act))+rimAt(l,ins);
  let outside=sc*(1.-${f(C.barShadow)}*exp(-max(sdBar(l-vec2f(0.,${f(C.barShadowDy)}))+ins,0.)/${f(C.barShadowSpread)}));
  return mix(outside,inside,cv);}
fn cont(lt:vec2f,blue:f32)->vec4f{let uv=(lt-u.b.xy)/u.b.zw;return textureSampleLevel(tC,smp,vec2f(uv.x,uv.y*.5+blue*.5),0.);}
fn tap(pos:vec2f,cpos:vec2f)->vec3f{let k=cont(cpos,1.)*mix(1.,${f(C.iconActiveAlpha)},clamp(u.c.w,0.,1.));return lensBack(pos)*(1.-k.a)+k.rgb*(1.+${f(C.hdrIconGain)}*(u.e.w-1.)+${IGLOW_W});}
@fragment fn fs(@builtin(position) fc:vec4f)->@location(0) vec4f{
  let dpr=u.e.z;let aa=1./dpr;let l=fc.xy/dpr;
  let d=sdBar(l);let cov=1.-smoothstep(-aa,aa,d);
  let shA=${f(C.barShadow)}*exp(-max(sdBar(l-vec2f(0.,${f(C.barShadowDy)})),0.)/${f(C.barShadowSpread)});
  let lc=vec2f(u.b.x+(u.c.x+u.c.y)*.5,u.b.y+u.b.w*.5);let hw=vec2f((u.c.y-u.c.x)*.5,u.c.z);let r=min(hw.x,hw.y);
  let lp=l-lc;let dl=sdb(lp,hw,r);
  if(cov<=0.&&dl>2.){return vec4f(0.,0.,0.,shA);}
  var c=vec3f(0.);var bodyC=vec3f(0.);
  if(cov>0.){
    bodyC=barBody(l);let k=cont(l,0.);c=bodyC*(1.-k.a)+k.rgb*(1.+${IGLOW_W});
    c+=vec3f(rimAt(l,0.));
    c*=1.-(${f(C.lensShadow)}+${f(C.lensShadowPress)}*u.c.w)*exp(-max(dl,0.)/${f(C.lensShadowSpread)});}
  let lensCov=1.-smoothstep(-aa,aa,dl);var lcol=vec3f(0.);
  if(dl<2.){
    let act=clamp(u.c.w,0.,1.);
    let wA=smoothstep(${f(C.lensOnStart)},${f(C.lensOnEnd)},act);
    let ki=cont(l,1.);
    lcol=mix(bodyC,${v3(C.idleTint).replace(/vec3\(/,'vec3f(')},${f(C.idleDarken)});
    lcol=lcol*(1.-ki.a)+ki.rgb*(1.+${f(C.hdrIconGain)}*(u.e.w-1.));
    if(wA>.001){
    let ln=normalize(vec2f(sdb(lp+vec2f(1.,0.),hw,r)-sdb(lp-vec2f(1.,0.),hw,r),sdb(lp+vec2f(0.,1.),hw,r)-sdb(lp-vec2f(0.,1.),hw,r))+1e-5);
    let bw=mix(${f(C.bevelWidthY)},${f(C.bevelWidthX)},pow(ln.x*ln.x,${f(C.bevelBlendPow)}));
    let dp=max(-dl,0.);let u1=1.-clamp(dp/bw,0.,1.);
    let q=sqrt(max(1.-u1*u1,0.));let hgt=${f(C.thickness)}*mix(q,1.,${f(C.edgeHeight)});
    let slope=min(${f(C.thickness)}*u1/(bw*max(q,.02)),${f(C.slopeMax)});
    let N=normalize(vec3f(ln*slope,1.));
    let base=lc+lp*mix(1.,${f(C.magnify)}-${f(C.magnifyPress)},act);let cb=lc+lp*mix(1.,${f(C.contentMagnify)},act);
    let R0=refract(vec3f(0.,0.,-1.),N,1./${f(C.ior)});
    let rk=mix(${f(C.idleRefract)},1.,act);
    let Dr=R0.xy/max(-R0.z,.25)*hgt;
    let D=Dr*${f(C.refractSign)}*act;
    let Db=Dr*${f(C.barBend)}*rk;
    let P0=base+Db;let C0=cb+D*${f(C.contentBend)};
    let wCA=pow(u1,${f(C.caPow)})*act*${f(C.caSpread)};
    var acc=vec3f(0.);
    if(wCA<.002){acc=tap(P0,C0);}
    else{
      var sum=vec3f(0.);var ws=vec3f(0.);
      for(var i=0;i<7;i++){let t=f32(i)/6.;let m=t*2.-1.;
        let w=vec3f(clamp(1.-t*1.4,0.,1.),clamp(1.-abs(t-.5)*2.,0.,1.),clamp(t*1.4-.4,0.,1.));
        sum+=tap(base+Db*(1.+wCA*m),cb+D*${f(C.contentBend)}*(1.+wCA*m*${f(C.caContent)}))*w;ws+=w;}
      acc=sum/ws;}
    var lensCol=acc*${f(C.lensBrightness)}+${f(C.lensLift)};
    lensCol*=1.-${f(C.edgeAbsorb)}*act*pow(u1,6.);
    let gS=1.+(u.e.w-1.)*${f(C.hdrSpecGain)};
    let L1=normalize(vec3f(LD,${f(C.lightZ)}));let L2=normalize(vec3f(-LD,${f(C.lightZ)}));
    let sp=pow(max(dot(N,normalize(L1+V)),0.),${f(C.shininess)})+${f(C.fillLight)}*pow(max(dot(N,normalize(L2+V)),0.),${f(C.shininess)});
    let fr=${f(C.fresnelF0)}+(1.-${f(C.fresnelF0)})*pow(1.-N.z,${f(C.fresnelPower)});
    lensCol+=(sp*${f(C.specular)}+(fr*${f(C.fresnelGain)}+(1.-smoothstep(0.,${f(C.rimWidth)},dp))*${f(C.rimLine)})*act)*gS;
    lcol=mix(lcol,lensCol,wA);}}
  return vec4f(c*cov*(1.-lensCov)+lcol*lensCov,lensCov+(1.-lensCov)*(cov+(1.-cov)*shA));}`;


/* ---------- Состояние и DOM ---------- */
const doc=nav.ownerDocument,win=doc.defaultView||window;
const F=new Float32Array(20),cc=doc.createElement('canvas'),sceneCv=doc.createElement('canvas');
const sctx=sceneCv.getContext('2d');
let dpr=1,idx=0,ok=true,rend=null,HDR=1,destroyed=false,raf=0,cvB=null,items=[],N=0,NR={w:0,h:0},bgColorCache='#0b0c12';
const S={xl:0,xr:0,vl:0,vr:0,p:0,pv:0,st:0};      // края ползунка, нажатие, сглаженное сжатие
const R={k:0,kv:0,o:0,ov:0};                       // «резинка» бара
let tc=0,pt=0,drag=false,tDown=0,idxDown=0,tapMode=false,x0=0,layoutKey='',settleRelease=false,tUp=0;
const still=win.matchMedia('(prefers-reduced-motion: reduce)').matches;
const cleanups=[];const on=(t,e,h,o)=>{t.addEventListener(e,h,o);cleanups.push(()=>t.removeEventListener(e,h,o));};

function injectStyle(){
  if(doc.getElementById('lg-nav-style'))return;
  const st=doc.createElement('style');st.id='lg-nav-style';
  st.textContent=`.lg-nav{position:relative;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent}
.lg-nav>*:not(.lg-canvas){position:relative;z-index:1}
.lg-canvas{position:absolute;display:block;pointer-events:none;z-index:0}
.lg-nav.lg-on>*:not(.lg-canvas){-webkit-text-fill-color:transparent!important;text-shadow:none!important}
.lg-nav.lg-on svg,.lg-nav.lg-on img{opacity:0!important}
.lg-nav.lg-fallback{background:rgba(40,40,44,.55);backdrop-filter:blur(22px) saturate(1.8);-webkit-backdrop-filter:blur(22px) saturate(1.8);border-radius:999px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.3)}`;
  doc.head.appendChild(st);
}
const getItems=()=>Array.from(nav.children).filter(el=>!el.classList.contains('lg-canvas')&&!el.hasAttribute('data-lg-ignore'));
const cell=()=>nav.offsetWidth/Math.max(N,1);
const hw0=()=>cell()/2-C.lensGap;
const clampX=x=>Math.max(cell()/2,Math.min(nav.offsetWidth-cell()/2,x));
const xIn=e=>e.clientX-nav.getBoundingClientRect().left;
const idxAt=x=>Math.max(0,Math.min(N-1,Math.floor(x/cell())));

/* ---------- WebGL (запасной путь) ---------- */
function sh(g,t,s){const o=g.createShader(t);g.shaderSource(o,s);g.compileShader(o);if(!g.getShaderParameter(o,g.COMPILE_STATUS))throw new Error(g.getShaderInfoLog(o));return o;}
function glProg(g,fs){const p=g.createProgram();g.attachShader(p,sh(g,g.VERTEX_SHADER,VS));g.attachShader(p,sh(g,g.FRAGMENT_SHADER,fs));g.bindAttribLocation(p,0,'a');g.linkProgram(p);
  if(!g.getProgramParameter(p,g.LINK_STATUS))throw new Error(g.getProgramInfoLog(p));
  const U={};for(let i=0,n=g.getProgramParameter(p,g.ACTIVE_UNIFORMS);i<n;i++){const nm=g.getActiveUniform(p,i).name;U[nm]=g.getUniformLocation(p,nm);}return{p,U};}
function glTri(g){g.bindBuffer(g.ARRAY_BUFFER,g.createBuffer());g.bufferData(g.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),g.STATIC_DRAW);g.enableVertexAttribArray(0);g.vertexAttribPointer(0,2,g.FLOAT,false,0,0);}
function glTex(g,w,h){const t=g.createTexture();g.bindTexture(g.TEXTURE_2D,t);
  if(w)g.texImage2D(g.TEXTURE_2D,0,g.RGBA,w,h,0,g.RGBA,g.UNSIGNED_BYTE,null);
  [[g.TEXTURE_MIN_FILTER,g.LINEAR],[g.TEXTURE_MAG_FILTER,g.LINEAR],[g.TEXTURE_WRAP_S,g.CLAMP_TO_EDGE],[g.TEXTURE_WRAP_T,g.CLAMP_TO_EDGE]].forEach(([k,v])=>g.texParameteri(g.TEXTURE_2D,k,v));return t;}
function initWebGL(cv){
  const g=cv.getContext('webgl',{antialias:false,alpha:true,premultipliedAlpha:true,powerPreference:'high-performance'});if(!g)throw 0;
  glTri(g);const PD=glProg(g,FSDOWN),PB=glProg(g,FSBAR);
  const tC=glTex(g,0,0);let RT=[];
  const mk=(w,h)=>{const t=glTex(g,w,h),fb=g.createFramebuffer();g.bindFramebuffer(g.FRAMEBUFFER,fb);g.framebufferTexture2D(g.FRAMEBUFFER,g.COLOR_ATTACHMENT0,g.TEXTURE_2D,t,0);return{t,fb,w,h};};
  return{hdr:1,
    size(){RT.forEach(r=>{g.deleteTexture(r.t);g.deleteFramebuffer(r.fb);});RT=[];
      let w=cv.width,h=cv.height;RT.push(mk(w,h));for(let i=0;i<3;i++){w=Math.max(1,Math.ceil(w/2));h=Math.max(1,Math.ceil(h/2));RT.push(mk(w,h));}
      F[16]=1/RT[3].w;F[17]=1/RT[3].h;},
    upload(){g.activeTexture(g.TEXTURE0);g.bindTexture(g.TEXTURE_2D,tC);g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL,false);g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);g.texImage2D(g.TEXTURE_2D,0,g.RGBA,g.RGBA,g.UNSIGNED_BYTE,cc);},
    uploadScene(){if(!RT.length)return;g.activeTexture(g.TEXTURE1);g.bindTexture(g.TEXTURE_2D,RT[0].t);g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL,true);g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);g.texImage2D(g.TEXTURE_2D,0,g.RGBA,g.RGBA,g.UNSIGNED_BYTE,sceneCv);g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL,false);},
    draw(){
      g.disable(g.BLEND);
      g.useProgram(PD.p);g.uniform1i(PD.U.uSrc,3);                                                    // цепочка downsample из загруженной сцены
      for(let i=1;i<4;i++){g.bindFramebuffer(g.FRAMEBUFFER,RT[i].fb);g.viewport(0,0,RT[i].w,RT[i].h);g.activeTexture(g.TEXTURE3);g.bindTexture(g.TEXTURE_2D,RT[i-1].t);
        g.uniform4f(PD.U.D,1/RT[i].w,1/RT[i].h,1/RT[i-1].w,1/RT[i-1].h);g.drawArrays(g.TRIANGLES,0,3);}
      g.useProgram(PB.p);g.bindFramebuffer(g.FRAMEBUFFER,null);g.viewport(0,0,cv.width,cv.height);   // композит
      g.activeTexture(g.TEXTURE0);g.bindTexture(g.TEXTURE_2D,tC);g.activeTexture(g.TEXTURE1);g.bindTexture(g.TEXTURE_2D,RT[0].t);g.activeTexture(g.TEXTURE2);g.bindTexture(g.TEXTURE_2D,RT[3].t);
      g.uniform1i(PB.U.uC,0);g.uniform1i(PB.U.uS,1);g.uniform1i(PB.U.uZ,2);
      g.uniform4f(PB.U.A,F[0],F[1],F[2],F[3]);g.uniform4f(PB.U.B,F[4],F[5],F[6],F[7]);g.uniform4f(PB.U.C,F[8],F[9],F[10],F[11]);g.uniform4f(PB.U.E,F[12],F[13],F[14],F[15]);g.uniform4f(PB.U.G,F[16],F[17],0,0);
      g.drawArrays(g.TRIANGLES,0,3);},
    destroy(){const e=g.getExtension('WEBGL_lose_context');if(e)e.loseContext();}};
}
/* ---------- WebGPU (основной путь, HDR) ---------- */
async function initWebGPU(cv){
  if(!win.navigator.gpu)throw 0;
  const ad=await win.navigator.gpu.requestAdapter();if(!ad)throw 0;const dev=await ad.requestDevice();
  const ctx=cv.getContext('webgpu'),fmt='rgba16float';
  ctx.configure({device:dev,format:fmt,alphaMode:'premultiplied',colorSpace:'display-p3',toneMapping:{mode:'extended'}});
  const cfg=ctx.getConfiguration?ctx.getConfiguration():null;
  const ext=cfg?(cfg.toneMapping&&cfg.toneMapping.mode==='extended'):true;
  const hdr=ext&&win.matchMedia('(dynamic-range: high)').matches?C.hdrPeak:1; // 1 = HDR выключен
  const mod=c=>dev.createShaderModule({code:c});
  const pipe=(code,fm)=>dev.createRenderPipelineAsync({layout:'auto',vertex:{module:mod(code),entryPoint:'vs'},fragment:{module:mod(code),entryPoint:'fs',targets:[{format:fm}]},primitive:{topology:'triangle-list'}});
  const [pD,pB]=await Promise.all([pipe(WG_DOWN,fmt),pipe(WG_BAR,fmt)]);
  const ub=dev.createBuffer({size:80,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const sp=dev.createSampler({magFilter:'linear',minFilter:'linear'});
  let T=[],bgD=[],bgB=null,tex=null;
  const UB=GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,TU=GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_DST;
  function mkBar(){if(!tex||!T.length)return;bgB=dev.createBindGroup({layout:pB.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:ub}},{binding:1,resource:sp},{binding:2,resource:tex.createView()},{binding:3,resource:T[0].createView()},{binding:4,resource:T[3].createView()}]});}
  return{hdr,
    size(){T.forEach(t=>t.destroy());T=[];const S2=[[cv.width,cv.height]];
      for(let i=0;i<3;i++){const[w,h]=S2[i];S2.push([Math.max(1,Math.ceil(w/2)),Math.max(1,Math.ceil(h/2))]);}
      S2.forEach(([w,h])=>T.push(dev.createTexture({size:[w,h],format:fmt,usage:TU})));
      F[16]=1/S2[3][0];F[17]=1/S2[3][1];
      bgD=[1,2,3].map(i=>{const b=dev.createBuffer({size:16,usage:UB});dev.queue.writeBuffer(b,0,new Float32Array([1/S2[i][0],1/S2[i][1],1/S2[i-1][0],1/S2[i-1][1]]));
        return dev.createBindGroup({layout:pD.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:b}},{binding:1,resource:sp},{binding:2,resource:T[i-1].createView()}]});});
      mkBar();},
    upload(){if(tex)tex.destroy();
      tex=dev.createTexture({size:[cc.width,cc.height],format:'rgba8unorm',usage:TU});
      dev.queue.copyExternalImageToTexture({source:cc},{texture:tex,premultipliedAlpha:true},[cc.width,cc.height]);mkBar();},
    uploadScene(){if(!T.length||!sceneCv.width)return;dev.queue.copyExternalImageToTexture({source:sceneCv},{texture:T[0]},[sceneCv.width,sceneCv.height]);},
    draw(){if(!bgB)return;dev.queue.writeBuffer(ub,0,F);
      const e=dev.createCommandEncoder();
      const run=(view,pl,bind)=>{const p=e.beginRenderPass({colorAttachments:[{view,clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}]});p.setPipeline(pl);p.setBindGroup(0,bind);p.draw(3);p.end();};
      for(let i=1;i<4;i++)run(T[i].createView(),pD,bgD[i-1]);           // downsample ×2 ×4 ×8 из загруженной сцены
      run(ctx.getCurrentTexture().createView(),pB,bgB);                 // преломление, дисперсия, tint, блики
      dev.queue.submit([e.finish()]);},
    destroy(){try{ctx.unconfigure();dev.destroy();}catch(e){}}};
}

/* ---------- Сцена под стеклом: то, что преломляется ---------- */
function resolveBgColor(){
  if(C.backgroundColor!=='auto'){bgColorCache=C.backgroundColor;return;}
  for(let el=nav.parentElement;el;el=el.parentElement){const c=win.getComputedStyle(el).backgroundColor;if(c&&c!=='transparent'&&!/rgba\(.*,\s*0\)$/.test(c)){bgColorCache=c;return;}}
  bgColorCache='#0b0c12';
}
function bgElement(){const b=C.background;if(!b)return null;if(typeof b==='string')return doc.querySelector(b);return b;}
function paintScene(time){
  const W=sceneCv.width,H=sceneCv.height;if(!W||!H)return;
  const nr=nav.getBoundingClientRect(),ox=nr.left-C.pad,oy=nr.top-C.pad;
  sctx.setTransform(1,0,0,1,0,0);sctx.globalAlpha=1;sctx.fillStyle=bgColorCache;sctx.fillRect(0,0,W,H);
  const b=C.background;
  if(typeof b==='function'){sctx.save();sctx.scale(dpr,dpr);sctx.translate(-ox,-oy);
    try{b(sctx,{time,dpr,x:ox,y:oy,width:W/dpr,height:H/dpr});}catch(e){console.error(e);}sctx.restore();return;}
  const el=bgElement();if(!el)return;
  const r=el.getBoundingClientRect();
  try{sctx.drawImage(el,(r.left-ox)*dpr,(r.top-oy)*dpr,r.width*dpr,r.height*dpr);}catch(e){}
}

/* ---------- Контент (иконки и подписи) из HTML → текстура ---------- */
let contentToken=0;
const SVG_PROPS=['stroke-linecap','stroke-linejoin','stroke-miterlimit','stroke-dasharray','stroke-dashoffset','fill-rule','clip-rule','fill-opacity','stroke-opacity'];
function svgImage(el,color,strokeK){ // <svg> → картинка нужного цвета; computed-стили переносятся в инлайн
  const r=el.getBoundingClientRect(),clone=el.cloneNode(true);
  const A=[el,...el.querySelectorAll('*')],B=[clone,...clone.querySelectorAll('*')];
  A.forEach((s,i)=>{const cs=win.getComputedStyle(s),d=B[i];let st='';
    ['fill','stroke'].forEach(p=>{let v=cs.getPropertyValue(p);if(v===cs.color)v=color;st+=`${p}:${v};`;});
    const sw=parseFloat(cs.getPropertyValue('stroke-width'));if(!isNaN(sw))st+=`stroke-width:${sw*strokeK};`;
    SVG_PROPS.forEach(p=>{const v=cs.getPropertyValue(p);if(v)st+=`${p}:${v};`;});
    if(i>0){const o=cs.getPropertyValue('opacity');if(o)st+=`opacity:${o};`;}
    d.setAttribute('style',(d.getAttribute('style')||'')+';'+st);});
  clone.setAttribute('xmlns','http://www.w3.org/2000/svg');
  if(!clone.getAttribute('viewBox'))clone.setAttribute('viewBox',`0 0 ${r.width} ${r.height}`);
  clone.setAttribute('width',Math.ceil(r.width*dpr));clone.setAttribute('height',Math.ceil(r.height*dpr));
  clone.setAttribute('style',(clone.getAttribute('style')||'')+`;color:${color};opacity:1;`);
  const img=new win.Image();img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new win.XMLSerializer().serializeToString(clone));
  return img.decode().then(()=>img);
}
async function drawContent(){
  if(!ok||!rend||destroyed)return;
  const tok=++contentToken,W=nav.offsetWidth,H=nav.offsetHeight;if(!W||!H)return;
  const nr=nav.getBoundingClientRect(),kx=nr.width?W/nr.width:1,ky=nr.height?H/nr.height:1;
  const rel=r=>({x:(r.left-nr.left)*kx,y:(r.top-nr.top)*ky,w:r.width*kx,h:r.height*ky});
  const sk=C.iconStrokeActive/C.iconStroke,cols=[C.iconWhite,C.iconBlue],jobs=[];
  items.forEach(it=>{
    it.querySelectorAll('svg,img').forEach(el=>{
      if(el.parentElement&&el.parentElement.closest('svg'))return;
      const r=rel(el.getBoundingClientRect());if(r.w<1||r.h<1)return;
      [0,1].forEach(v=>jobs.push({v,kind:'img',r,p:el.tagName.toLowerCase()==='svg'?svgImage(el,cols[v],v?sk:1):Promise.resolve(el)}));
    });
    const tw=doc.createTreeWalker(it,win.NodeFilter.SHOW_TEXT);
    for(let n;(n=tw.nextNode());){
      const pe=n.parentElement,t=n.textContent.replace(/\s+/g,' ').trim();if(!t||!pe||pe.closest('svg,script,style'))continue;
      const rg=doc.createRange();rg.selectNodeContents(n);const r=rel(rg.getBoundingClientRect());if(r.w<1)continue;
      const cs=win.getComputedStyle(pe),txt=cs.textTransform==='uppercase'?t.toUpperCase():cs.textTransform==='lowercase'?t.toLowerCase():t;
      [0,1].forEach(v=>jobs.push({v,kind:'text',r,txt,font:`${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,ls:cs.letterSpacing}));
    }
  });
  const imgs=await Promise.all(jobs.map(j=>j.p?j.p.catch(()=>null):null));
  if(tok!==contentToken||destroyed)return;
  cc.width=Math.round(W*dpr);cc.height=Math.round(2*H*dpr);
  const x=cc.getContext('2d');x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,W,2*H);
  jobs.forEach((j,i)=>{const oy=j.v?H:0;
    if(j.kind==='img'){if(imgs[i])x.drawImage(imgs[i],j.r.x,oy+j.r.y,j.r.w,j.r.h);}
    else{x.fillStyle=cols[j.v];x.font=j.font;x.textAlign='center';x.textBaseline='middle';if('letterSpacing' in x)x.letterSpacing=j.ls==='normal'?'0px':j.ls;x.fillText(j.txt,j.r.x+j.r.w/2,oy+j.r.y+j.r.h/2);}});
  rend.upload();
}

/* ---------- Геометрия ---------- */
function layout(){
  if(destroyed||!cvB)return;
  dpr=Math.min(win.devicePixelRatio||1,C.maxDpr);
  items=getItems();N=items.length;
  const W=nav.offsetWidth,H=nav.offsetHeight,oldW=NR.w;NR={w:W,h:H};
  const cw=W+C.pad*2,ch=H+C.pad*2;
  cvB.style.left=-(C.pad+nav.clientLeft)+'px';cvB.style.top=-(C.pad+nav.clientTop)+'px';const lk=cw+'x'+ch+'@'+dpr,resized=lk!==layoutKey;layoutKey=lk; // размер канваса/текстур меняем только если он реально изменился (иначе лаг при смене dir)
  if(resized){cvB.style.width=cw+'px';cvB.style.height=ch+'px';}
  if(resized){cvB.width=sceneCv.width=Math.round(cw*dpr);cvB.height=sceneCv.height=Math.round(ch*dpr);}
  F[0]=cw;F[1]=ch;F[2]=0;F[3]=0;F[4]=C.pad;F[5]=C.pad;F[6]=W;F[7]=H;F[14]=dpr;F[15]=HDR;
  resolveBgColor();
  if(rend){if(resized)rend.size();paintScene(0);rend.uploadScene();}
  if(idx>=N)idx=Math.max(0,N-1);
  if(!drag){tc=cell()*(idx+.5);
    if(oldW>0&&W>0){const k=W/oldW;S.xl*=k;S.xr*=k;S.vl*=k;S.vr*=k;} // пересчёт вёрстки (смена dir/ресайз): ползунок не «телепортируется», а плавно доезжает пружиной
    else{S.xl=tc-hw0();S.xr=tc+hw0();S.vl=S.vr=0;}}
  drawContent();
}

/* ---------- Выбор вкладки ---------- */
function markCurrent(i){items.forEach((b,k)=>k===i?b.setAttribute('aria-current','page'):b.removeAttribute('aria-current'));}
function setIdx(i,emit=true){
  if(i===idx||i<0||i>=N)return;idx=i;markCurrent(i);
  if(emit){nav.dispatchEvent(new win.CustomEvent('lg-change',{detail:{index:i,item:items[i]}}));if(typeof C.onChange==='function')C.onChange(i,items[i]);}
}
function syncFromDom(){const k=items.findIndex(b=>b.getAttribute('aria-current')&&b.getAttribute('aria-current')!=='false');if(k>=0&&k!==idx&&!drag){idx=k;tc=cell()*(k+.5);}}

/* ---------- Ввод ---------- */
on(nav,'pointerdown',e=>{if(!N||e.button>0)return;drag=true;nav.setPointerCapture(e.pointerId);pt=1;tDown=performance.now();idxDown=idx;tapMode=true;settleRelease=false;x0=xIn(e);tc=clampX(xIn(e));setIdx(idxAt(tc));});
on(nav,'pointermove',e=>{if(!drag)return;if(tapMode&&Math.abs(xIn(e)-x0)>C.tapMoveSlop)tapMode=false;tc=clampX(xIn(e));setIdx(idxAt(tc));});
function up(){if(!drag)return;drag=false;tc=cell()*(idx+.5);
  if(tapMode&&C.tapHoldPress){settleRelease=true;tUp=performance.now();}
  else setTimeout(()=>{if(!drag)pt=0;},Math.max(0,C.pressHold-(performance.now()-tDown)));
  if(C.clickOnSelect&&idx!==idxDown&&items[idx])items[idx].click();}
on(nav,'pointerup',up);on(nav,'pointercancel',up);
on(nav,'click',e=>{if(e.detail!==0)return;const k=items.findIndex(b=>b.contains(e.target));if(k>=0){setIdx(k);tc=cell()*(k+.5);}});
on(nav,'keydown',e=>{if(e.key!=='ArrowRight'&&e.key!=='ArrowLeft')return;
  const k=Math.max(0,Math.min(N-1,idx+(e.key==='ArrowRight'?1:-1)));if(k===idx)return;e.preventDefault();
  setIdx(k);tc=cell()*(k+.5);items[k].focus();if(C.clickOnSelect)items[k].click();});

/* ---------- Физика и кадр ---------- */
const DT=1/C.physicsHz; // фиксированный шаг → одинаковая плавность на 60 и 120 Гц
function step(){
  if(settleRelease&&!drag){const now=performance.now(),mid=(S.xl+S.xr)/2; // тап: отпускаем «нажатие», когда ползунок доехал (или через 2.5 с на всякий случай)
    if((Math.abs(mid-tc)<1.5&&Math.abs(S.vl+S.vr)*.5<30&&now-tDown>=C.pressHold)||now-tUp>2500){pt=0;settleRelease=false;}}
  S.pv+=((pt-S.p)*C.pressStiffness-S.pv*2*C.pressDamping*Math.sqrt(C.pressStiffness))*DT;S.p+=S.pv*DT;
  const grow=Math.max(S.p,-.25),hw=hw0()+grow*C.pressGrowX,mid=(S.xl+S.xr)/2;
  const s=Math.max(-1,Math.min(1,(tc-mid)/(cell()*.5))),a=Math.max(s,0),b=Math.max(-s,0);
  const f2=tapMode?C.tapSpeed*C.tapSpeed:1,kr=(C.stiffness+C.leadBoost*a-C.lagPenalty*b)*f2,kl=(C.stiffness+C.leadBoost*b-C.lagPenalty*a)*f2; // плавно, без скачков
  S.vl+=((tc-hw-S.xl)*kl-S.vl*2*C.damping*Math.sqrt(kl))*DT;S.xl+=S.vl*DT;
  S.vr+=((tc+hw-S.xr)*kr-S.vr*2*C.damping*Math.sqrt(kr))*DT;S.xr+=S.vr*DT;
  // «резиновый» бар: цель зависит от скорости и положения ползунка, работает только пока ползунок нажат
  const v=(S.vl+S.vr)*.5,pr=Math.min(Math.max(S.p,0),1),kk=C.barRubberStiffness,cd=2*C.barRubberDamping*Math.sqrt(kk);
  const tk=Math.min(Math.abs(v)*C.barRubberByVelocity,C.barRubberMax)*pr;
  const nx=NR.w?Math.max(-1,Math.min(1,((S.xl+S.xr)/2-NR.w/2)/(NR.w/2))):0;
  const to=(nx*C.barFollow+Math.max(-1,Math.min(1,v/C.barLeanSpeed))*C.barLean)*pr;
  R.kv+=((tk-R.k)*kk-R.kv*cd)*DT;R.k+=R.kv*DT;
  R.ov+=((to-R.o)*kk-R.ov*cd)*DT;R.o+=R.ov*DT;
}
let last=performance.now(),acc=0,time=0;
function frame(now){
  if(destroyed)return;
  const dt=Math.min((now-last)/1000,.05);last=now;acc+=dt;if(!still)time+=dt;
  while(acc>=DT){step();acc-=DT;}
  if(ok&&rend&&N){
    const grow=Math.max(S.p,-.25);
    S.st+=(Math.min(Math.abs(S.vl+S.vr)*.5*C.stretchBySpeed,C.stretchMax)-S.st)*Math.min(1,dt*C.stretchSmooth);
    const pr=Math.min(Math.max(S.p,0),1),sx=(1+C.barPressScale*pr)*(1+R.k),sy=(1+C.barPressScale*pr)*(1-R.k*C.barRubberSquash);
    const bw=NR.w*sx,bh=NR.h*sy; // деформированный бар: увеличение при касании + «резинка»
    F[4]=C.pad+(NR.w-bw)/2+R.o;F[5]=C.pad+(NR.h-bh)/2;F[6]=bw;F[7]=bh;
    F[8]=S.xl*sx;F[9]=S.xr*sx;F[10]=(NR.h/2-C.lensInsetY+grow*C.pressGrowY-S.st)*sy; // ползунок деформируется вместе с баром
    F[11]=Math.max(S.p,0);F[12]=time;F[13]=win.innerHeight;
    if(C.liveBackground||sceneDirty){paintScene(time);rend.uploadScene();sceneDirty=false;}
    rend.draw();
  }
  raf=win.requestAnimationFrame(frame);
}
let sceneDirty=true;

/* ---------- Наблюдатели: HTML изменился / размер изменился ---------- */
let pending=false;
function schedule(){if(pending||destroyed)return;pending=true;win.requestAnimationFrame(()=>{pending=false;if(destroyed)return;layout();syncFromDom();sceneDirty=true;});}
const mo=new win.MutationObserver(list=>{
  const real=list.filter(m=>m.target!==cvB&&!(m.type==='attributes'&&m.attributeName==='aria-current'));
  const cur=list.some(m=>m.type==='attributes'&&m.attributeName==='aria-current');
  if(real.length)schedule();else if(cur){items=getItems();N=items.length;syncFromDom();}
});
const ro=new win.ResizeObserver(schedule);
on(win,'resize',schedule);
if(doc.fonts&&doc.fonts.ready)doc.fonts.ready.then(()=>drawContent());

function fail(){ok=false;nav.classList.remove('lg-on');nav.classList.add('lg-fallback');if(cvB)cvB.remove();}
function makeCanvas(){const c=doc.createElement('canvas');c.className='lg-canvas';nav.prepend(c);return c;}

/* ---------- Запуск ---------- */
injectStyle();
nav.classList.add('lg-nav');
const ready=(async()=>{
  items=getItems();N=items.length;
  const k0=items.findIndex(b=>b.getAttribute('aria-current')&&b.getAttribute('aria-current')!=='false');idx=Math.max(0,k0);
  if(N&&k0<0)markCurrent(idx);
  cvB=makeCanvas();
  try{rend=await initWebGPU(cvB);}catch(e){
    if(e!==0)console.warn('[liquid-glass-nav] WebGPU недоступен, WebGL:',e);
    cvB.remove();cvB=makeCanvas(); // канвас, занятый WebGPU, заменяем чистым для WebGL
    try{rend=initWebGL(cvB);}catch(err){console.error(err);fail();return;}}
  if(destroyed){rend.destroy&&rend.destroy();return;}
  HDR=rend.hdr;nav.classList.add('lg-on');layout();
  mo.observe(nav,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['aria-current','d','viewBox','src','href','data-lg-ignore']});
  ro.observe(nav);
  raf=win.requestAnimationFrame(frame);
})();

return{
  ready,
  get index(){return idx;},
  select(i){setIdx(i);tc=cell()*(i+.5);},                 // программно выбрать вкладку (с событием lg-change)
  refresh(){resolveBgColor();sceneDirty=true;layout();syncFromDom();}, // пересчитать после смены HTML/CSS/фона
  get canvas(){return cvB;},
  destroy(){destroyed=true;win.cancelAnimationFrame(raf);cleanups.forEach(fn=>fn());mo.disconnect();ro.disconnect();
    if(rend&&rend.destroy)rend.destroy();if(cvB)cvB.remove();nav.classList.remove('lg-nav','lg-on','lg-fallback');}
};
}
