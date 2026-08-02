@echo off
echo Starting deployment process...
git add .
git commit -m "Auto deploy from script"
git push
echo Deployment pushed to GitHub successfully!
pause
