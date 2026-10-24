' Pet Health Tracker auto-start (ASCII only, do not add non-ASCII comments)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\User\GitHub\pet-health-app"
sh.Run """C:\Users\User\AppData\Local\Programs\Python\Python312\pythonw.exe"" server.py", 0, False
