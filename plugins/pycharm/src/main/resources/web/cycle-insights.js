// Browser-ready cycle presentation shared by the desktop and both editor plugins.
(function (root) {
  function path(cycle, edges) {
    const members = new Set(cycle.modules || []);
    const links = edges.filter(edge => edge.is_top_level !== false && members.has(edge.source) && members.has(edge.target));
    const valid = candidate => candidate.length > 2 && candidate[0] === candidate[candidate.length - 1]
      && candidate.slice(0, -1).every((source, index) => links.some(edge => edge.source === source && edge.target === candidate[index + 1]));
    if (valid(cycle.path || [])) return cycle.path;
    const neighbors = new Map();
    for (const edge of links) neighbors.set(edge.source, [...(neighbors.get(edge.source) || []), edge.target]);
    function walk(node, start, visited, route) {
      for (const next of (neighbors.get(node) || []).sort()) {
        if (next === start && route.length > 1) return [...route, start];
        if (!visited.has(next)) {
          const result = walk(next, start, new Set([...visited, next]), [...route, next]);
          if (result.length) return result;
        }
      }
      return [];
    }
    for (const start of [...members].sort()) {
      const found = walk(start, start, new Set([start]), [start]);
      if (found.length) return found;
    }
    return [];
  }

  function suggestion(cycle, edges) {
    if (cycle.suggestion) return cycle.suggestion;
    const route = path(cycle, edges);
    const edge = edges.find(item => item.source === route[0] && item.target === route[1] && item.is_top_level !== false);
    return edge ? { source: edge.source, target: edge.target, line: edge.line, kind: 'unknown' } : null;
  }

  function guidance(kind) {
    if (kind === 'type_only') return '型注釈でのみ直接参照されています。遅延評価できる注釈にしたうえで TYPE_CHECKING への移動を検討してください。';
    if (kind === 'runtime') return '実行時にも参照されています。共通定義の抽出、または依存方向の変更を検討してください。';
    return '用途を静的に特定できません。参照箇所を確認し、共通定義の抽出や依存方向の変更を検討してください。';
  }

  function summary(cycle, edges) {
    const route = path(cycle, edges);
    const names = route.length ? route : cycle.modules || [];
    return names.map(id => id.split('.').pop()).join(route.length ? ' ➔ ' : '・');
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  root.ModuleLoomCycles = { path, suggestion, guidance, summary, escapeHtml };
})(globalThis);
