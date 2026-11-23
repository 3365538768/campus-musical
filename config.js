// 点击统计、热门搜索与匿名评论用的 Supabase 项目（留空则这些功能自动隐藏）。
// anon key 是公开的只读/新增权限 key，权限由数据库里的 RLS 规则限制（见 supabase.sql）。
window.CM_CFG = {
  supabaseUrl: 'https://syxfufckpudajfcwamkw.supabase.co',
  anonKey: 'sb_publishable_Hy_v-uhHDu2Xy7NEJpmt3w_oRC6H6rK',
  // 数据文件的 CDN（国内访问比 GitHub Pages 快）；按发布时的提交号取固定版本，失败自动回落到本站
  cdn: 'https://cdn.jsdelivr.net/gh/3365538768/campus-musical',
};
