import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 关掉开发模式左下角的 Next.js Dev Tools 气泡（生产构建不出现，纯开发期干扰）
  devIndicators: false,
  // 关键：关闭 Next 的 gzip 响应压缩。浏览器 fetch 默认发送 Accept-Encoding: gzip，
  // 压缩中间件会把 SSE 流式响应整体缓冲（推理文字逐字符到达，永远填不满 zlib 缓冲区），
  // 导致蓝图生成期间前端收不到任何流式文字、生成结束才一次性全部吐出。
  // 实测证据：带 Accept-Encoding: gzip 时代理响应为 Content-Encoding: gzip + chunked；
  // 关掉后 SSE 按事件实时透传，前端才看得到滚动文字。
  compress: false,
  // 导入文档全文可能远超默认 10MB，提高代理转发请求体上限，避免比对/生成时被截断导致 500
  experimental: {
    proxyClientMaxBodySize: "100mb",
    // 代理默认 30s 超时；蓝图校验比对是 LLM 长任务（实测约 60s+），调大到 10 分钟避免代理提前掐断返回 500
    proxyTimeout: 600000,
  },
  async rewrites() {
    // 开发期把 /api/* 代理到后端 FastAPI，避免跨域与 SSE 转发问题
    return [
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:8000/api/:path*",
      },
    ];
  },
};

export default nextConfig;
