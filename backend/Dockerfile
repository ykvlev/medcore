# Сервер MEDCORE в контейнере. Сборка из корня репозитория:
#   docker build -f backend/Dockerfile -t medcore-api .
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
# global.json фиксирует локальный SDK 10.0.403; в образе он может отличаться.
COPY global.json .
RUN rm -f global.json
COPY backend/ ./backend/
RUN dotnet restore backend/Medcore.Api/Medcore.Api.csproj
RUN dotnet publish backend/Medcore.Api/Medcore.Api.csproj -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app .
# Шрифт с кириллицей кладётся рядом с приложением: в образе .NET шрифтов нет,
# а установка пакетов зависит от доступности репозиториев в сборочной сети.
COPY backend/fonts/ /app/fonts/
# Порт задаёт хостинг (Render передаёт PORT); локально приложение слушает 5180.
ENV ASPNETCORE_ENVIRONMENT=Production
EXPOSE 8080
ENTRYPOINT ["dotnet", "Medcore.Api.dll"]
