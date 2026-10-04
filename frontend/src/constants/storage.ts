/**
 * @file constants/storage.ts
 * localStorage 静态键常量：与 utils/storage.ts 的键构造函数（按小说 id 动态拼接）配合使用，
 * 集中声明所有存储键，避免各处手写字符串漂移。
 */

/** localStorage 键：用户关闭空书架指引后记 "1"，此后不再展示。 */
export const GUIDE_KEY = "biling.guide.hidden";

/** localStorage 键：写作页评价栏占比偏好，跨刷新保持。 */
export const REVIEW_RATIO_KEY = "biling.reviewRatio";
