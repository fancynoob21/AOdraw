import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    DEFAULT_HISTORY_DEPTH, HISTORY_ALL, HISTORY_DEPTH_OPTIONS, hydrateStartIndex,
} from '../src/history.js';

/** 用起始下标反推「实际会渲染几层」，断言起来更直观 */
const rendered = (total, depth) => total - hydrateStartIndex(total, depth);

describe('HISTORY_DEPTH_OPTIONS', () => {
    it('默认值在选项里', () => {
        assert.ok(HISTORY_DEPTH_OPTIONS.some(o => o.value === DEFAULT_HISTORY_DEPTH));
        assert.equal(DEFAULT_HISTORY_DEPTH, 5);
    });

    it('有「全部」这个出口', () => {
        assert.ok(HISTORY_DEPTH_OPTIONS.some(o => o.value === HISTORY_ALL));
    });

    it('值互不重复且递增（-1 排最后）', () => {
        const finite = HISTORY_DEPTH_OPTIONS.filter(o => o.value >= 0).map(o => o.value);
        assert.deepEqual(finite, [...finite].sort((a, b) => a - b));
        assert.equal(new Set(finite).size, finite.length);
    });
});

describe('hydrateStartIndex', () => {
    it('深度 N 渲染 N+1 层（最新那层永远算在内）', () => {
        assert.equal(rendered(100, 5), 6);
        assert.equal(rendered(100, 3), 4);
        assert.equal(rendered(100, 20), 21);
    });

    it('深度 0 只渲染最新一层', () => {
        // 这是关键：深度 0 绝不能把刚生成出来的那层也关掉，
        // 否则本插件的核心功能直接失效
        assert.equal(rendered(100, 0), 1);
        assert.equal(hydrateStartIndex(100, 0), 99);
    });

    it('负数表示全部', () => {
        assert.equal(hydrateStartIndex(100, HISTORY_ALL), 0);
        assert.equal(rendered(100, HISTORY_ALL), 100);
    });

    it('深度超过楼层总数时就是全部，不会算出负下标', () => {
        assert.equal(hydrateStartIndex(3, 50), 0);
        assert.equal(rendered(3, 50), 3);
    });

    it('楼层数为 0 或非法时返回 0', () => {
        assert.equal(hydrateStartIndex(0, 5), 0);
        assert.equal(hydrateStartIndex(-1, 5), 0);
        assert.equal(hydrateStartIndex(NaN, 5), 0);
    });

    it('只有 1 层时无论深度多少都渲染它', () => {
        for (const depth of [0, 5, 100, HISTORY_ALL]) {
            assert.equal(hydrateStartIndex(1, depth), 0, `depth=${depth}`);
        }
    });

    it('深度设置坏掉时退回默认值，而不是不渲染', () => {
        // 少渲染的表现是「图莫名其妙不出来」，比多花点 CPU 难查得多，
        // 所以坏值要往「多渲染」的方向退
        for (const bad of [undefined, null, '', 'abc', NaN]) {
            assert.equal(rendered(100, bad), DEFAULT_HISTORY_DEPTH + 1, `depth=${bad}`);
        }
    });

    it('字符串形式的深度可以接受（下拉读出来是字符串）', () => {
        assert.equal(hydrateStartIndex(100, '5'), hydrateStartIndex(100, 5));
        assert.equal(hydrateStartIndex(100, '-1'), 0);
    });

    it('小数向下取整', () => {
        assert.equal(hydrateStartIndex(100, 5.9), hydrateStartIndex(100, 5));
    });

    it('每个下拉选项都能算出合法下标', () => {
        for (const option of HISTORY_DEPTH_OPTIONS) {
            const start = hydrateStartIndex(200, option.value);
            assert.ok(start >= 0 && start < 200, `${option.label} 算出了 ${start}`);
        }
    });
});
