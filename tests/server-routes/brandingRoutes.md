# 品牌设置保存合同

前提：隔离home和随机localhost HTTP，运行 `pnpm exec vitest run src/server/routes/brandingRoutes.test.ts src/server/webUiBrandingStore.test.ts`。

1. POST标题和显示方式，检查200、去空白后响应、实际JSON文件及重新创建store后的状态一致。
2. 无效显示方式/非法JSON返回400，随后合法保存仍成功。
3. 空body/null/array按原合同作为空更新；并发不同字段保存后两字段都保留。
4. GET或其他路径交还下一handler。品牌保存仍在custom connection.ready屏障之前处理，不依赖账号或原生RPC。

清理：关闭本次随机服务并删除合成home；只revert对应route迁移提交。既有Logo图像验证和store串行写继续由原store测试覆盖。
