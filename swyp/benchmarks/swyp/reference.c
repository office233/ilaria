/* Same scalar algorithms and float64 representation as compute.swyp.
   Compile this source as both C and C++. No fast-math or FMA contraction. */
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <windows.h>
static double timer(void) {LARGE_INTEGER t,f;QueryPerformanceCounter(&t);QueryPerformanceFrequency(&f);return (double)t.QuadPart/f.QuadPart;}
static double mandelbrot(double width) {
 double height=width/2,py=0,checksum=0;
 while(py<height){double px=0;while(px<width){
  double cr=px*3.5/width-2.5,ci=py*2/height-1,zr=0,zi=0,count=0;
  while(count<80 && zr*zr+zi*zi<=4){double next=zr*zr-zi*zi+cr;zi=2*zr*zi+ci;zr=next;count=count+1;}
  checksum=checksum+count;px=px+1;
 }py=py+1;}return checksum;
}
static int prime(double n){double divisor=2;while(divisor*divisor<=n){if(fmod(n,divisor)==0)return 0;divisor=divisor+1;}return 1;}
static double primes(double limit){double n=2,count=0;while(n<=limit){if(prime(n))count=count+1;n=n+1;}return count;}
static double train(double epochs){
 double weight=0,bias=0,epoch=0;
 while(epoch<epochs){double dw=0,db=0,i=0;while(i<256){double x=fmod(i,64)/32-1,target=2*x+1,error=weight*x+bias-target;dw=dw+2*error*x;db=db+2*error;i=i+1;}
 weight=weight-0.1*dw/256;bias=bias-0.1*db/256;epoch=epoch+1;}
 double loss=0,i=0;while(i<256){double x=fmod(i,64)/32-1,error=weight*x+bias-(2*x+1);loss=loss+error*error;i=i+1;}loss=loss/256;
 printf("WEIGHTS %.17g %.17g %.17g\n",weight,bias,loss);return loss;
}
int main(int argc,char**argv){if(argc!=3)return 2;double mode=strtod(argv[1],NULL),size=strtod(argv[2],NULL),start=timer(),result;
 if(mode==0)result=mandelbrot(size);else if(mode==1)result=primes(size);else result=train(size);
 printf("RESULT %.17g %.17g\n",timer()-start,result);return 0;
}
