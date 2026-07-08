/**
 * 陪伴对象配置：白名单 + 称呼映射 + 生产守卫。
 *
 * XIAOHE_COMPANION_ALLOW_OPENIDS = ou_a,ou_b        允许陪伴的 openId（逗号分隔）
 * XIAOHE_COMPANION_NAMES         = ou_a:小明,ou_b:阿雨   openId→称呼（让小合知道在陪谁）
 * XIAOHE_ALLOW_ALL_P2P           = true              显式允许放行所有私聊（生产默认禁）
 */

const allow = new Set(
  (process.env.XIAOHE_COMPANION_ALLOW_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean),
);

const names = new Map();
for (const pair of (process.env.XIAOHE_COMPANION_NAMES || '').split(',')) {
  const [id, name] = pair.split(':').map(s => s?.trim());
  if (id && name) names.set(id, name);
}

const allowAll = /^(1|true|yes)$/i.test(process.env.XIAOHE_ALLOW_ALL_P2P || '');

/**
 * 生产安全守卫：production 下既没白名单、又没显式 ALLOW_ALL_P2P → 拒绝启动，
 * 避免"任何人私聊都进入亲密陪伴"的误配。
 */
export function assertCompanionConfig() {
  const prod = process.env.NODE_ENV === 'production';
  if (prod && allow.size === 0 && !allowAll) {
    throw new Error(
      '[Xiaohe] 生产环境未配置陪伴白名单（XIAOHE_COMPANION_ALLOW_OPENIDS 为空），'
      + '拒绝启动以防对陌生人开放亲密陪伴。要么设白名单，要么显式 XIAOHE_ALLOW_ALL_P2P=true。',
    );
  }
}

export function isCompanionTarget(openId) {
  if (allow.size === 0) return allowAll || process.env.NODE_ENV !== 'production';
  return allow.has(openId);
}

/** 返回该人的称呼（无则返回 null，人设会走"还在认识你"的措辞）。 */
export function nameOf(openId) {
  return names.get(openId) || null;
}

export function companionSummary() {
  return allow.size
    ? `白名单 ${allow.size} 人${names.size ? `（${names.size} 人有称呼）` : ''}`
    : (allowAll ? '放行所有私聊（XIAOHE_ALLOW_ALL_P2P）' : '放行所有私聊（dev）');
}
