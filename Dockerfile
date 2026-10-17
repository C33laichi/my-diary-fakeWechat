# 我的日记 —— 网页版容器
#
# 整个应用就一个 index.html：样式、结构、逻辑全在里面，页面里 0 处外部链接。
# 所以这里不需要 npm install、不需要构建步骤，复制一个文件进去就完事了。
#
# ⚠️ 重要：容器里【不存任何日记数据】。
#    数据写在访问者浏览器的 IndexedDB 里（不可用时降级到 localStorage）。
#    Docker 解决的是「部署方便」，不是「多端同步」——
#    换手机、换浏览器、清缓存，看到的就是另一份互不相干的数据。
#    另外 file:// 直接双击打开和 http:// 访问是两个不同的 origin，数据本就不互通。

FROM nginx:1.27-alpine

# nginx:alpine 的默认站点根目录就是这里，默认 index 就是 index.html，
# 访问 "/" 会自动命中，连配置文件都不用改。
COPY index.html /usr/share/nginx/html/index.html

EXPOSE 80

# alpine 自带 busybox wget；容器起不来时 docker ps 会直接标 unhealthy
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
