module.exports = {
  apps: [{
    name: 'xiaohe',
    script: 'src/server.js',
    cwd: __dirname,
    instances: 1,           // ⚠️ 必须单实例：飞书同一 bot 应用只能一个进程连 WS
    watch: false,
    max_memory_restart: '400M',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: 'logs/error.log',
    out_file: 'logs/out.log',
    merge_logs: true,
    env: { NODE_ENV: 'production' },
  }],
};
