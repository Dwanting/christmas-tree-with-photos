import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import multer from 'multer';
import type { Plugin } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default function photoServer(): Plugin {
  return {
    name: 'vite-plugin-photo-server',
    configureServer(server) {
      // 配置 multer 存储
      const storage = multer.diskStorage({
        destination: function (_req, _file, cb) {
          const dir = path.resolve(__dirname, 'public/photos');
          if (!fs.existsSync(dir)){
              fs.mkdirSync(dir, { recursive: true });
          }
          cb(null, dir);
        },
        filename: function (_req, file, cb) {
          // 尝试解决中文文件名乱码问题
          let name = file.originalname;
          try {
             name = Buffer.from(file.originalname, 'latin1').toString('utf8');
          } catch (_e) {
             // ignore
          }
          cb(null, name);
        }
      });
      
      const upload = multer({ storage: storage });

      // 获取 base 路径，确保以 / 结尾
      let base = server.config.base || '/';
      if (!base.endsWith('/')) base += '/';

      const apiPhotos = base + 'api/photos';
      const apiReset = base + 'api/reset';
      const apiUpload = base + 'api/upload';

      console.log(`[PhotoServer] API endpoints registered:`);
      console.log(`  GET  ${apiPhotos}`);
      console.log(`  POST ${apiReset}`);
      console.log(`  POST ${apiUpload}`);
      console.log(`  DELETE ${apiPhotos}`);

      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0];
        
        // GET /api/photos - 获取照片列表
        if (req.method === 'GET' && url === apiPhotos) {
          const userDir = path.resolve(__dirname, 'public/photos');
          const backupDir = path.resolve(__dirname, 'public/backup_photos');
          
          try {
            // 1. 尝试读取用户上传目录
            let userFiles: string[] = [];
            if (fs.existsSync(userDir)) {
               userFiles = fs.readdirSync(userDir).filter(file => {
                 const ext = path.extname(file).toLowerCase();
                 return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
               });
            }

            let resultFiles: string[] = [];
            
            // 2. 如果用户目录有图片，则使用用户图片
            if (userFiles.length > 0) {
               // 返回相对路径 photos/xxx.jpg
               resultFiles = userFiles.map(f => `photos/${f}`);
            } else {
               // 3. 否则使用备份目录
               if (fs.existsSync(backupDir)) {
                   const backupFiles = fs.readdirSync(backupDir).filter(file => {
                     const ext = path.extname(file).toLowerCase();
                     return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
                   });
                   // 返回相对路径 backup_photos/xxx.jpg
                   resultFiles = backupFiles.map(f => `backup_photos/${f}`);
               }
            }
            
            // 排序
            resultFiles.sort((a, b) => {
                const nameA = path.basename(a);
                const nameB = path.basename(b);
                const numA = parseInt(nameA);
                const numB = parseInt(nameB);
                if (!isNaN(numA) && !isNaN(numB)) {
                    return numA - numB;
                }
                return nameA.localeCompare(nameB);
            });

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(resultFiles));
          } catch (err) {
            console.error('Error reading photos directory:', err);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: 'Failed to list photos' }));
          }
          return;
        }

        // POST /api/reset - 清空用户照片
        if (req.method === 'POST' && url === apiReset) {
            const userDir = path.resolve(__dirname, 'public/photos');
            try {
                if (fs.existsSync(userDir)) {
                    const files = fs.readdirSync(userDir);
                    for (const file of files) {
                        // 只删除图片文件，保留 .gitkeep
                        if (file !== '.gitkeep') {
                             fs.unlinkSync(path.join(userDir, file));
                        }
                    }
                }
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: true }));
            } catch (err) {
                console.error('Reset error:', err);
                res.statusCode = 500;
                res.end(JSON.stringify({ error: 'Reset failed' }));
            }
            return;
        }

        // POST /api/upload - 上传照片
        if (req.method === 'POST' && url === apiUpload) {
           const uploadMiddleware = upload.array('photos');
           uploadMiddleware(req as any, res as any, (err) => {
             if (err) {
               console.error('Upload error:', err);
               res.statusCode = 500;
               res.end(JSON.stringify({ error: 'Upload failed' }));
               return;
             }
             res.setHeader('Content-Type', 'application/json');
             res.end(JSON.stringify({ success: true, count: (req as any).files?.length }));
           });
           return;
        }

        // DELETE /api/photos - 删除单个照片
        if (req.method === 'DELETE' && url === apiPhotos) {
             // 解析 query 参数
             // req.url 可能是 /christmas-tree-with-photos/api/photos?filename=xxx
             const fullUrl = 'http://localhost' + req.url;
             const urlObj = new URL(fullUrl);
             const filename = urlObj.searchParams.get('filename');
             
             if (!filename) {
                 res.statusCode = 400;
                 res.setHeader('Content-Type', 'application/json');
                 res.end(JSON.stringify({ error: 'Filename is required' }));
                 return;
             }

             // 安全检查：防止目录遍历
             if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
                 res.statusCode = 400;
                 res.setHeader('Content-Type', 'application/json');
                 res.end(JSON.stringify({ error: 'Invalid filename' }));
                 return;
             }

             const userDir = path.resolve(__dirname, 'public/photos');
             const filePath = path.join(userDir, filename);

             try {
                 if (fs.existsSync(filePath)) {
                     fs.unlinkSync(filePath);
                     res.setHeader('Content-Type', 'application/json');
                     res.end(JSON.stringify({ success: true }));
                 } else {
                     // 尝试在 backup 中找？不，只允许删除用户上传的
                     res.statusCode = 404;
                     res.setHeader('Content-Type', 'application/json');
                     res.end(JSON.stringify({ error: 'File not found or cannot delete backup photos' }));
                 }
             } catch (err) {
                 console.error('Delete error:', err);
                 res.statusCode = 500;
                 res.setHeader('Content-Type', 'application/json');
                 res.end(JSON.stringify({ error: 'Delete failed' }));
             }
             return;
        }

        next();
      });
    }
  };
}
